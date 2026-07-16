// 上流（Moodle webservice）↔ worker 境界のランタイム検証スキーマ。
// 200-HTML や必須フィールド欠損（itemid/canattempt/token 等）がそのまま
// undefined 参照・NaN・500 になるのを防ぐため、コードが実際に消費する
// フィールドだけを薄く検証する。応答全体はモデル化しない（未使用フィールドは無視）。
// 検証失敗は UpstreamError（router 側で 502）に倒す。

import { z } from 'zod';
import { UpstreamError } from '../errors';

/** safeParse し、形状が不正なら UpstreamError（502）を投げる。成功時は検証済みデータを返す。 */
export function parseMoodleResponse<T>(schema: z.ZodType<T>, data: unknown, wsfunction: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    // ZodError の field-path 等の詳細はサーバーログのみに出し、クライアントへ返す
    // 502 body には汎用メッセージのみ含める（上流の内部形状を露出させない）。
    console.error(`Moodle ${wsfunction} response shape invalid:`, result.error.message);
    throw new UpstreamError(`Moodle ${wsfunction} response shape invalid`);
  }
  return result.data;
}

// --- token ---------------------------------------------------------------
export const TokenResponseSchema = z.object({
  token: z.string().optional(),
  error: z.string().optional(),
});

// --- サイト情報 / コース一覧 ---------------------------------------------
export const SiteInfoSchema = z.object({
  userid: z.number(),
});

export const UserCoursesSchema = z.array(
  z.object({
    id: z.number(),
    fullname: z.string(),
    shortname: z.string(),
    visible: z.number().optional(),
  }),
);

// --- 課題（mod_assign） ---------------------------------------------------
export const AssignmentsResponseSchema = z.object({
  courses: z.array(
    z.object({
      id: z.number(),
      fullname: z.string(),
      assignments: z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          // intro は show_intro()（VALUE_OPTIONAL）でのみ返る。提出開始前の課題では
          // 欠落するため required にすると一覧全体が 502 になる。既定 '' で吸収する。
          intro: z.string().default(''),
          duedate: z.number(),
          cutoffdate: z.number().optional(),
        }),
      ),
    }),
  ),
});

export const SubmissionStatusSchema = z.object({
  lastattempt: z
    .object({
      submission: z
        .object({ status: z.string().optional(), timemodified: z.number().optional() })
        .optional(),
      teamsubmission: z
        .object({ status: z.string().optional(), timemodified: z.number().optional() })
        .optional(),
      gradingstatus: z.string().optional(),
    })
    .optional(),
});

// --- クイズ（mod_quiz） ---------------------------------------------------
export const QuizListResponseSchema = z.object({
  quizzes: z.array(
    z.object({
      id: z.number(),
      course: z.number(),
      name: z.string(),
      // intro / timeopen / timeclose / timelimit / attempts は quiz webservice 上
      // VALUE_OPTIONAL で、権限や状態によって学生には欠落し得る。required にすると
      // 一覧全体が 502 になるため、既定値（数値は 0 = 未設定/無制限の扱い、文字列は ''）
      // で吸収する。消費側は 0/'' を既に「未設定」として扱っている。
      intro: z.string().default(''),
      timeopen: z.number().default(0),
      timeclose: z.number().default(0),
      timelimit: z.number().default(0),
      attempts: z.number().default(0),
    }),
  ),
});

export const QuizAccessInfoSchema = z.object({
  canattempt: z.boolean(),
  preventaccessreasons: z.array(z.string()).optional(),
});

export const UserAttemptsSchema = z.object({
  attempts: z
    .array(
      z.object({
        id: z.number().optional(),
        state: z.string().optional(),
        timefinish: z.number().optional(),
      }),
    )
    .optional(),
});

// mod_quiz_start_attempt は受験不可時に attempt:[]（空配列）+ warnings を返すため
// attempt は unknown のまま受け、実際の attempt オブジェクトは StartedAttemptSchema で判定する。
export const StartAttemptResponseSchema = z.object({
  attempt: z.unknown(),
  warnings: z.array(z.object({ message: z.string().optional() })).optional(),
});

export const StartedAttemptSchema = z.object({
  id: z.number(),
  quiz: z.number(),
  attempt: z.number(),
  state: z.string(),
});

export const AttemptDataSchema = z.object({
  questions: z
    .array(
      z.object({
        slot: z.number(),
        page: z.number(),
        // type は VALUE_OPTIONAL（設問タイプが非表示だと欠落し得る）。既定 '' で吸収する。
        type: z.string().default(''),
        html: z.string(),
      }),
    )
    .optional(),
  nextpage: z.number().optional(),
});

export const AttemptReviewSchema = z.object({
  grade: z.union([z.string(), z.number()]).nullish(),
  attempt: z.object({
    id: z.number(),
    quiz: z.number(),
    attempt: z.number(),
    state: z.string(),
    sumgrades: z.number().nullish(),
    timefinish: z.number().optional(),
  }),
  questions: z
    .array(
      z.object({
        slot: z.number(),
        // type は VALUE_OPTIONAL（設問タイプが非表示だと欠落し得る）。既定 '' で吸収する。
        type: z.string().default(''),
        page: z.number(),
        html: z.string(),
        status: z.string().optional(),
        mark: z.string().optional(),
        maxmark: z.number().optional(),
      }),
    )
    .optional(),
});

// --- ファイル提出 / コース内ファイル -------------------------------------
export const DraftItemIdSchema = z.object({
  itemid: z.number(),
});

export const ResourcesResponseSchema = z.object({
  resources: z.array(
    z.object({
      name: z.string(),
      coursemodule: z.number(),
      contentfiles: z
        .array(
          z.object({
            filename: z.string(),
            fileurl: z.string(),
            filesize: z.number(),
            mimetype: z.string(),
          }),
        )
        .optional(),
    }),
  ),
});
