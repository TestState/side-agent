import {TranslationProcessor} from "./translation-processor";
import {
    AttachmentSchema,
    Capability,
    create,
    PayloadSchema,
    translationCapability,
    TranslationResultSchema,
    TranslationSessionContext,
    TranslationState,
    TranslationStatusSchema
} from "testgenesis-client-node";
import _javaExporter from "@seleniumhq/code-export-java-junit";
import {CommandShape, ProjectShape, TestShape} from "@seleniumhq/side-model";
import {LanguageEmitter} from "@seleniumhq/side-code-export";

const javaExporter = ((_javaExporter as any).default || _javaExporter) as LanguageEmitter;

export default class JavaCodeExportProcessor extends TranslationProcessor {
    getCapability(): Capability {
        return translationCapability({
            type: "selenium-ide-to-java-junit",
            sourcePayloads: [
                {
                    type: "selenium-side",
                    isRequired: true,
                    acceptedMimeTypes: ["application/json"]
                },
                {
                    type: "selenium-variable",
                    isRepeatable: true,
                    acceptedMimeTypes: ["application/json"]
                },
                {
                    type: "selenium-config",
                    acceptedMimeTypes: ["application/json"]
                }
            ],
            targetPayloads: [
                {
                    type: "java-junit",
                    isRequired: true,
                    isRepeatable: true,
                    acceptedMimeTypes: ["text/x-java", "text/x-java-source", "application/x-java-source"]
                },
                {
                    type: "junit-config",
                    isRequired: false,
                    acceptedMimeTypes: ["text/plain"]
                }
            ]
        });
    }

    async process(sessionId: string, context: TranslationSessionContext) {
        const init = context.init;
        const payloads = init.payloads;
        const payload = payloads.find((p: any) => p.type === "selenium-side");

        if (!payload?.attachment) {
            await context.sendStatus(create(TranslationStatusSchema, {
                state: TranslationState.INVALID,
                message: "Missing required test payload or attachment"
            }));
            return;
        }

        let parsedTest: Partial<TestShape>;
        try {
            parsedTest = JSON.parse(new TextDecoder().decode(payload.attachment.data));
        } catch (err: any) {
            throw new Error(`Failed to parse test payload as JSON: ${err.message}`);
        }

        let variableCommands: CommandShape[] = [];
        let binaryPath = process.env.WEBDRIVER_CHROME_BINARY || process.env.CHROME_BINARY;

        const variablePayloads = payloads.filter((p: any) => p.type === "selenium-variable");
        for (const variablePayload of variablePayloads) {
            if (variablePayload.attachment) {
                try {
                    const variableObject = JSON.parse(new TextDecoder().decode(variablePayload.attachment.data));
                    for (const [key, value] of Object.entries(variableObject)) {
                        if (key === "binaryPath") binaryPath = String(value);

                        variableCommands.push({
                            id: "x-variable-" + variableCommands.length,
                            command: "store",
                            target: String(value),
                            value: key,
                        })
                    }
                } catch (e) {
                }
            }
        }

        let browserArgs: string[] = [];
        let userPrefs: any = {};
        const configPayload = payloads.find((p: any) => p.type === "selenium-config");
        if (configPayload?.attachment) {
            try {
                const config = JSON.parse(new TextDecoder().decode(configPayload.attachment.data));
                if (Array.isArray(config.args)) {
                    browserArgs = config.args;
                }
                if (config.prefs) {
                    userPrefs = config.prefs;
                }
            } catch (e) {
            }
        }

        const test: TestShape = {
            id: parsedTest.id || sessionId,
            name: (parsedTest.name || "UAP_Execution").replace(/[^a-zA-Z0-0_]/g, "_"),
            commands: [
                ...variableCommands,
                ...(parsedTest.commands || []).filter(cmd => !cmd.comment?.includes("#LOCAL_ONLY#"))
            ]
        };

        const project: ProjectShape = {
            id: test.id,
            name: "UAP Project",
            url: "",
            tests: [test],
            suites: [],
            urls: [],
            plugins: [],
            version: "2.0",
            snapshot: {
                tests: [],
                dependencies: {},
                jest: { extraGlobals: [] }
            }
        };

        await context.sendStatus(create(TranslationStatusSchema, {
            state: TranslationState.PROCESSING,
            message: "Exporting to Java JUnit..."
        }));

        let { filename, body } = await javaExporter.emit.test({
            test,
            tests: [test],
            baseUrl: "",
            project,
            enableOriginTracing: false,
            beforeEachOptions: undefined,
            enableDescriptionAsComment: false
        });

        // Apply transformations with self-detection script
        body = this.transformSource(body, binaryPath, browserArgs, userPrefs);

        await context.sendResult(create(TranslationResultSchema, {
            status: create(TranslationStatusSchema, {state: TranslationState.COMPLETED}),
            payloads: [
                create(PayloadSchema, {
                    type: "java-junit",
                    attachment: create(AttachmentSchema, {
                        name: filename,
                        mimeType: "text/x-java-source",
                        data: new TextEncoder().encode(body)
                    })
                }),
                create(PayloadSchema, {
                    type: "junit-config",
                    attachment: create(AttachmentSchema, {
                        name: "junit-config.txt",
                        mimeType: "text/plain",
                        data: new TextEncoder().encode("org.seleniumhq.selenium:selenium-java:4.43.0")
                    })
                })
            ]
        }));

        await context.sendStatus(create(TranslationStatusSchema, {
            state: TranslationState.COMPLETED,
            message: `Successfully exported to ${filename}`
        }));
    }

    private transformSource(source: string, binPath: string | undefined, args: string[], prefs: any): string {
        const remoteUrl = `System.getenv("SELENIUM_REMOTE_URL")`;

        let argsSnippet = "";
        if (args.length > 0) {
            argsSnippet = args.map(arg => `opt.addArguments("${arg}");`).join("\n    ");
        }

        const mergedPrefs = {
            "profile.password_manager_leak_detection": false,
            "profile.password_manager_enabled": false,
            "profile.password_manager_leak_detection_enabled": false,
            "credentials_enable_service": false,
            ...prefs
        };

        // If user passed nested profile, flatten it for simpler Java code generation
        if (prefs.profile) {
            for (const [key, value] of Object.entries(prefs.profile)) {
                mergedPrefs[`profile.${key}`] = value;
            }
            delete (mergedPrefs as any).profile;
        }

        let prefsSnippet = "java.util.Map<String, Object> prefs = new java.util.HashMap<>();\n";
        for (const [key, value] of Object.entries(mergedPrefs)) {
            if (typeof value === "string") {
                prefsSnippet += `    prefs.put("${key}", "${value}");\n`;
            } else {
                prefsSnippet += `    prefs.put("${key}", ${value});\n`;
            }
        }
        
        const chromeSnippet = `org.openqa.selenium.chrome.ChromeOptions opt = new org.openqa.selenium.chrome.ChromeOptions();
    ${argsSnippet}
    ${prefsSnippet}
    opt.setExperimentalOption("prefs", prefs);
    String remote = ${remoteUrl};
    if (remote != null && !remote.isEmpty()) {
        try { driver = new org.openqa.selenium.remote.RemoteWebDriver(new java.net.URL(remote), opt); }
        catch (java.net.MalformedURLException e) { throw new RuntimeException(e); }
    } else {
        String bin = System.getProperty("webdriver.chrome.binary", "${binPath || ""}");
        if (bin.isEmpty()) bin = System.getenv("CHROME_BINARY");
        if (bin == null || bin.isEmpty()) {
            for (String c : new String[]{"thorium-browser-avx", "google-chrome-stable", "google-chrome", "chromium"}) {
                java.io.File f = new java.io.File("/usr/bin/" + c);
                if (f.canExecute()) { bin = f.getAbsolutePath(); break; }
            }
        }
        if (bin != null && !bin.isEmpty()) opt.setBinary(bin);
        driver = new org.openqa.selenium.chrome.ChromeDriver(opt);
    }`;

        const firefoxSnippet = `org.openqa.selenium.firefox.FirefoxOptions opt = new org.openqa.selenium.firefox.FirefoxOptions();
    ${argsSnippet}
    String remote = ${remoteUrl};
    if (remote != null && !remote.isEmpty()) {
        try { driver = new org.openqa.selenium.remote.RemoteWebDriver(new java.net.URL(remote), opt); }
        catch (java.net.MalformedURLException e) { throw new RuntimeException(e); }
    } else {
        String bin = System.getProperty("webdriver.gecko.binary");
        if (bin == null) {
            for (String c : new String[]{"thorium-browser-avx", "firefox"}) {
                 java.io.File f = new java.io.File("/usr/bin/" + c);
                 if (f.canExecute()) { bin = f.getAbsolutePath(); break; }
            }
        }
        if (bin != null) opt.setBinary(bin);
        driver = new org.openqa.selenium.firefox.FirefoxDriver(opt);
    }`;

        return source
            .replace("driver = new ChromeDriver();", chromeSnippet)
            .replace("driver = new FirefoxDriver();", firefoxSnippet);
    }
}