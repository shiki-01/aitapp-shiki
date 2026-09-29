fn main() {
    // option_env!("AITAPP_WORKER_BASE_URL"/"AITAPP_APP_ORIGIN")（src/config.rs）はコンパイル時の値を
    // 埋め込むが、Cargo は環境変数の変更を自動検知しないため、明示しないと値が変わっても再コンパイルされない。
    println!("cargo:rerun-if-env-changed=AITAPP_WORKER_BASE_URL");
    println!("cargo:rerun-if-env-changed=AITAPP_APP_ORIGIN");
    tauri_build::build();
}
