const reset = process.argv.includes("--reset");
console.log(reset ? "Drawbound fixture reset requested." : "Drawbound fixture is deterministic and initialized on first request.");
console.log("Mode: fixture | Network: signet | Vault: vault:taurus:signet:drawbound-demo");
