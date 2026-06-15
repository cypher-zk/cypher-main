fn main() {
    println!("cargo::rerun-if-env-changed=CYPHER_CLUSTER");
    println!("cargo::rustc-check-cfg=cfg(cypher_mainnet)");
    if std::env::var("CYPHER_CLUSTER").as_deref() == Ok("mainnet") {
        println!("cargo::rustc-cfg=cypher_mainnet");
    }
}
