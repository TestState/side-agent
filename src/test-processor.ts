import {
    Attachment,
    AttachmentSchema,
    cleanObject,
    create,
    msToDuration,
    StepReportSchema,
    StepStatus,
    SummarySchema,
    testCapability,
    TestSessionContext,
    TestSessionProcessor,
    TestState,
    timestampFromDate
} from "testgenesis-client-node";

import {TestLogger, TestRunner} from "@hsgamer/side-engine";
import * as selenium from "selenium-webdriver";
import {Builder, WebDriver} from "selenium-webdriver";
import * as chrome from "selenium-webdriver/chrome";
import * as firefox from "selenium-webdriver/firefox";
import * as safari from "selenium-webdriver/safari";
import * as edge from "selenium-webdriver/edge";
import * as os from "os";
import {CommandStates, PlaybackStates, Variables, WebDriverExecutor} from "@seleniumhq/side-runtime";
import type {TestShape} from "@seleniumhq/side-model";

const seleniumVersion = (selenium as any).version as string | undefined;

type WebDriverExecutorConstructorArgs = ConstructorParameters<typeof WebDriverExecutor>[0];
type TestReport = ReturnType<TestLogger["createReport"]>;

/**
 * Singleton handler for Selenium-based test jobs.
 */
export class TestProcessor implements TestSessionProcessor {
    constructor(
        private readonly onDriverCreated: (driver: WebDriver) => void,
        private readonly onDriverDestroyed: (driver: WebDriver) => void,
        private readonly seleniumRemoteUrl?: string
    ) {
    }

    public getCapability() {
        return testCapability({
            type: "selenium-side",
            payloads: [
                {type: "selenium-side", isRequired: true, acceptedMimeTypes: ["application/json"]},
                {type: "selenium-variable", isRepeatable: true, acceptedMimeTypes: ["application/json"]},
                {type: "selenium-config", acceptedMimeTypes: ["application/json"]}
            ]
        });
    }

    public async process(sessionId: string, context: TestSessionContext) {
        await new TestSession(
            sessionId,
            context,
            this.onDriverCreated,
            this.onDriverDestroyed,
            this.seleniumRemoteUrl
        ).execute();
    }
}

/**
 * Per-session logic for Selenium test execution.
 */
class TestSession {
    private driver: WebDriver | null = null;

    constructor(
        private readonly sessionId: string,
        private readonly context: TestSessionContext,
        private readonly onDriverCreated: (driver: WebDriver) => void,
        private readonly onDriverDestroyed: (driver: WebDriver) => void,
        private readonly seleniumRemoteUrl?: string
    ) {
    }

    public async execute() {
        let logger: TestLogger | undefined;
        let testRunner: TestRunner | undefined;
        let startTime: Date = new Date();
        let endTime: Date | undefined;
        let capabilities: selenium.Capabilities | undefined;
        let attachments: Attachment[] = [];
        const screenshotMap = new Map<string, string>();
        let takeScreenshot = false;

        try {
            const init = this.context.init;
            const {payloads} = init;
            const payload = payloads.find((p: any) => p.type === "selenium-side");

            if (!payload?.attachment) {
                await this.context.sendStatus({
                    state: TestState.INVALID,
                    message: "Missing required test payload or attachment"
                });
                return;
            }

            let parsedTest: Partial<TestShape>;
            try {
                parsedTest = JSON.parse(new TextDecoder().decode(payload.attachment.data));
            } catch (err: any) {
                throw new Error(`Failed to parse test payload as JSON: ${err.message}`);
            }

            const variables = new Variables();
            const variablePayloads = payloads.filter((p: any) => p.type === "selenium-variable");
            for (const variablePayload of variablePayloads) {
                if (variablePayload.attachment) {
                    try {
                        const variableObject = JSON.parse(new TextDecoder().decode(variablePayload.attachment.data));
                        for (const [key, value] of Object.entries(variableObject)) {
                            variables.set(key, value);
                        }
                    } catch (e) {
                    }
                }
            }

            let browser = "chrome";
            let args: string[] = [];
            let userPrefs: any = {};
            const configPayload = payloads.find((p: any) => p.type === "selenium-config");
            if (configPayload?.attachment) {
                try {
                    const config = JSON.parse(new TextDecoder().decode(configPayload.attachment.data));
                    browser = config.browser || browser;
                    takeScreenshot = config.takeScreenshot || takeScreenshot;
                    if (Array.isArray(config.args)) {
                        args = config.args;
                    }
                    if (config.prefs) {
                        userPrefs = config.prefs;
                    }
                } catch (e) {
                }
            }

            await this.context.sendStatus({
                state: TestState.ACKNOWLEDGED,
                message: "Initializing Selenium..."
            });

            const test: TestShape = {
                id: parsedTest.id || this.sessionId,
                name: parsedTest.name || "UAP Execution",
                commands: (parsedTest.commands || []).filter(cmd => !cmd.comment?.includes("#LOCAL_ONLY#"))
            };

            if (!test.commands.length) {
                throw new Error("Invalid test payload: 'commands' property is missing or empty.");
            }

            const builder = new Builder().forBrowser(browser);
            if (this.seleniumRemoteUrl) builder.usingServer(this.seleniumRemoteUrl);

            const mergedPrefs = {
                profile: {
                    password_manager_leak_detection: false,
                    password_manager_enabled: false,
                    password_manager_leak_detection_enabled: false,
                    ...userPrefs.profile
                },
                credentials_enable_service: false,
                ...userPrefs
            };

            if (browser === "chrome") {
                let options = new chrome.Options();
                if (args.length > 0) options.addArguments(...args);
                options.setUserPreferences(mergedPrefs);
                builder.setChromeOptions(options);
            } else if (browser === "firefox") {
                let options = new firefox.Options();
                if (args.length > 0) options.addArguments(...args);
                builder.setFirefoxOptions(options);
            } else if (browser === "edge") {
                let options = new edge.Options();
                if (args.length > 0) options.addArguments(...args);
                options.setUserPreferences(mergedPrefs);
                builder.setEdgeOptions(options);
            } else if (browser === "safari") {
                builder.setSafariOptions(new safari.Options());
            }

            this.driver = await builder.build();
            this.onDriverCreated(this.driver);

            capabilities = await this.driver.getCapabilities();

            let webDriverExecutorArgs: WebDriverExecutorConstructorArgs = {
                driver: this.driver,
                hooks: {
                    onAfterCommand: async (hook: any) => {
                        if (takeScreenshot) {
                            const data = await this.driver!.takeScreenshot();
                            const name = `screenshot-${hook.command.id}.png`;
                            attachments.push(create(AttachmentSchema, {
                                name,
                                mimeType: "image/png",
                                data: Buffer.from(data, 'base64')
                            }));
                            screenshotMap.set(hook.command.id, name);
                        }
                    }
                }
            };

            logger = new TestLogger();
            testRunner = TestRunner.createRunner(test, {
                logger: logger.createConsole(),
                variables: variables,
                executor: new WebDriverExecutor(webDriverExecutorArgs)
            });
            logger.bind(testRunner);

            await this.context.sendTelemetry(`Session started for browser: ${browser}`);
            await this.context.sendStatus({
                state: TestState.RUNNING,
                message: "Running steps..."
            });

            startTime = new Date();
            try {
                await testRunner.run();
            } catch (runErr) {
                console.error(`[Test ${this.sessionId}] Execution error:`, runErr);
            }
            endTime = new Date();

            // Capture final screenshot
            if (takeScreenshot && this.driver) {
                try {
                    const data = await this.driver.takeScreenshot();
                    const name = "final-screenshot.png";
                    attachments.push(create(AttachmentSchema, {
                        name,
                        mimeType: "image/png",
                        data: Buffer.from(data, 'base64')
                    }));
                } catch (e) {
                    console.warn(`[Test ${this.sessionId}] Failed to capture final screenshot:`, e);
                }
            }

            const report = testRunner.createReport(logger) as TestReport;
            const finalState = report.state === PlaybackStates.FINISHED ? TestState.COMPLETED : TestState.FAILED;

            await this.context.sendResult({
                status: {state: finalState},
                reports: report.commands.map(cmd => create(StepReportSchema, {
                    name: `${cmd.command.command} ${cmd.command.target || ""}`,
                    status: cmd.state === CommandStates.PASSED ? StepStatus.PASSED : StepStatus.FAILED,
                    summary: create(SummarySchema, {
                        startTime: timestampFromDate(cmd.timestamp[0]?.timestamp || new Date()),
                        totalDuration: msToDuration(
                            cmd.timestamp.length >= 2
                                ? (cmd.timestamp[cmd.timestamp.length - 1]?.timestamp.getTime() || 0) - (cmd.timestamp[0]?.timestamp.getTime() || 0)
                                : 0
                        ),
                        metadata: cleanObject({
                            timestamp: cmd.timestamp.map(t => ({
                                timestamp: t.timestamp.toISOString(),
                                state: String(t.state),
                                message: t.message,
                                error: t.error ? {
                                    message: t.error.message,
                                    stack: t.error.stack
                                } : undefined
                            })),
                            command: cmd.command,
                            screenshot: screenshotMap.get(cmd.id)
                        })
                    })
                })),
                summary: create(SummarySchema, {
                    startTime: timestampFromDate(report.timestamp[0]?.timestamp || startTime),
                    totalDuration: msToDuration(
                        report.timestamp.length >= 2
                            ? (report.timestamp[report.timestamp.length - 1]?.timestamp.getTime() || endTime!.getTime()) -
                            (report.timestamp[0]?.timestamp.getTime() || startTime.getTime())
                            : endTime!.getTime() - startTime.getTime()
                    ),
                    metadata: cleanObject({
                        total_steps: report.commands.length,
                        selenium_webdriver_version: seleniumVersion,
                        browser_name: capabilities?.getBrowserName(),
                        browser_version: capabilities?.getBrowserVersion(),
                        platform_name: capabilities?.getPlatform(),
                        execute_duration: (endTime?.getTime() || Date.now()) - startTime.getTime(),
                        os_platform: os.platform(),
                        os_release: os.release(),
                        os_arch: os.arch(),
                        cpu_model: os.cpus()[0]?.model,
                        cpu_count: os.cpus().length,
                        memory_total_gb: Math.round(os.totalmem() / (1024 ** 3)),
                        browser_args: (capabilities?.get("goog:chromeOptions") || capabilities?.get("ms:edgeOptions") || {}).args || args,
                        browser_prefs: (capabilities?.get("goog:chromeOptions") || capabilities?.get("ms:edgeOptions") || {}).prefs || mergedPrefs
                    })
                }),
                attachments
            });

            await this.context.sendStatus({state: finalState});
        } catch (err: any) {
            console.error(`[Test ${this.sessionId}] Setup Error:`, err);
            await this.context.sendStatus({
                state: TestState.FAILED,
                message: `Setup Error: ${err.message}`
            });
        } finally {
            if (testRunner) {
                await testRunner.cleanup().catch(() => {
                });
            }
            if (this.driver) {
                this.onDriverDestroyed(this.driver);
                await this.driver.quit().catch(() => {
                });
                this.driver = null;
            }
        }
    }
}
