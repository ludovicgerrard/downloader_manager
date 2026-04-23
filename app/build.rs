fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default() == "windows" {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("app.ico");
        res.set("ProductName", "SwiftDL Download Manager");
        res.set("FileDescription", "SwiftDL Download Manager");
        res.set("LegalCopyright", "2025");
        res.compile().expect("Failed to compile Windows resources");
    }
}
