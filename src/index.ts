import type { WebDriver } from "selenium-webdriver";
import { parseArgs } from "node:util";
import { TestProcessor } from "./test-processor";
import { TranslationProcessor } from "./translation-processor";
import { SideMergeProcessor } from "./merge-processor";
import JavaCodeExportProcessor from "./code-export-java";

/**
 * Encapsulates the application configuration from CLI arguments
 * and environment variables.
 */
const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
        name: { type: "string", short: "n" },
        url: { type: "string", short: "u" },
        selenium: { type: "string", short: "s" },
    },
});

const CONFIG = {
    HUB_URL: values.url || process.env.HUB_URL || "http://localhost:9000",
    CLIENT_NAME: values.name || process.env.CLIENT_NAME || "SideAgent-" + Math.random().toString(36).substring(7),
    SELENIUM_REMOTE_URL: values.selenium || process.env.SELENIUM_REMOTE_URL,
};

console.log(`[SideAgent] Hub: ${CONFIG.HUB_URL}`);
console.log(`[SideAgent] Name: ${CONFIG.CLIENT_NAME}`);
if (CONFIG.SELENIUM_REMOTE_URL) {
    console.log(`[SideAgent] Selenium: ${CONFIG.SELENIUM_REMOTE_URL}`);
}

const activeDrivers = new Set<WebDriver>();
let isShuttingDown = false;

async function main() {
    const { Agent } = await import("teststate-client-node");
    const agent = new Agent({
        hubUrl: CONFIG.HUB_URL,
        displayName: CONFIG.CLIENT_NAME,
    });

    // Register Processors (Framework handles Clients, Streams, and Init)
    agent.registerTestProcessor(
        new TestProcessor(
            (d) => activeDrivers.add(d),
            (d) => activeDrivers.delete(d),
            CONFIG.SELENIUM_REMOTE_URL,
        ),
    );

    agent.registerTranslationProcessor(new TranslationProcessor());

    agent.registerTranslationProcessor(new SideMergeProcessor());

    agent.registerTranslationProcessor(new JavaCodeExportProcessor());

    // Handle Shutdown
    async function shutdown() {
        if (isShuttingDown) return;
        isShuttingDown = true;
        console.log("\n[Shutdown] Cleaning up...");
        agent.shutdown();
        for (const driver of activeDrivers) await driver.quit().catch(() => {});
        setTimeout(() => process.exit(0), 1000);
    }

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Start Agent
    await agent.start();
}

main().catch(console.error);
