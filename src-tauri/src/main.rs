// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `botcage --mcp <controlPort>` runs as the desktop MCP server for one bot's
    // Claude Code session instead of opening a window. Same binary, so there is
    // no separate runtime to install or bundle.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--mcp") {
        match args.next().and_then(|port| port.parse::<u16>().ok()) {
            Some(port) => botcage_lib::serve_mcp(port, args.next().map(std::path::PathBuf::from)),
            None => {
                eprintln!("usage: botcage --mcp <control-port>");
                std::process::exit(2);
            }
        }
        return;
    }

    botcage_lib::run()
}
