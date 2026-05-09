import {
    AttachmentSchema,
    create,
    PayloadSchema,
    translationCapability,
    TranslationSessionContext,
    TranslationSessionProcessor,
    TranslationState,
} from "teststate-client-node";
import type { ProjectShape, TestShape, SuiteShape } from "@seleniumhq/side-model";

/**
 * Processor to merge multiple 'selenium-side' payloads into a single 'selenium-side-project'.
 */
export class SideMergeProcessor implements TranslationSessionProcessor {
    public getCapability() {
        return translationCapability({
            type: "selenium-side-to-project",
            sourcePayloads: [
                {
                    type: "selenium-side",
                    isRequired: true,
                    isRepeatable: true,
                    acceptedMimeTypes: ["application/json"],
                },
            ],
            targetPayloads: [
                {
                    type: "selenium-side-project",
                    isRequired: true,
                    acceptedMimeTypes: ["application/octet-stream"],
                },
            ],
        });
    }

    public async process(sessionId: string, context: TranslationSessionContext) {
        try {
            const init = context.init;
            await context.sendStatus({
                state: TranslationState.ACKNOWLEDGED,
                message: "Starting SIDE payloads merge...",
            });

            const sourcePayloads = init.payloads.filter((p: any) => p.type === "selenium-side");
            if (sourcePayloads.length === 0) {
                await context.sendStatus({
                    state: TranslationState.FAILED,
                    message: "No selenium-side payloads found to merge",
                });
                return;
            }

            await context.sendTelemetry(`Merging ${sourcePayloads.length} payloads...`);

            const tests: TestShape[] = [];
            for (const payload of sourcePayloads) {
                if (!payload.attachment) continue;

                try {
                    const test: TestShape = JSON.parse(new TextDecoder().decode(payload.attachment.data));
                    tests.push(test);
                    await context.sendTelemetry(`Added test: ${test.name}`);
                } catch (e: any) {
                    await context.sendTelemetry(
                        `Failed to parse payload: ${payload.attachment.name}. Error: ${e.message}`,
                    );
                }
            }

            if (tests.length === 0) {
                await context.sendStatus({
                    state: TranslationState.FAILED,
                    message: "No valid tests found in payloads",
                });
                return;
            }

            const project: ProjectShape = {
                id: crypto.randomUUID(),
                version: "2.0",
                name: "Merged Project",
                url: "", // Default URL, might need adjustment
                tests: tests,
                suites: [],
                urls: [],
                plugins: [],
                snapshot: {
                    tests: [],
                    dependencies: {},
                    jest: {
                        extraGlobals: [],
                    },
                },
            };

            await context.sendResult({
                status: { state: TranslationState.COMPLETED },
                payloads: [
                    create(PayloadSchema, {
                        type: "selenium-side-project",
                        attachment: create(AttachmentSchema, {
                            name: "merged-project.side",
                            mimeType: "application/octet-stream",
                            data: new TextEncoder().encode(JSON.stringify(project)),
                        }),
                    }),
                ],
            });

            await context.sendStatus({
                state: TranslationState.COMPLETED,
                message: `Successfully merged ${tests.length} tests into a single project.`,
            });
        } catch (err: any) {
            console.error(`[Merge ${sessionId}] Error:`, err);
            await context.sendStatus({
                state: TranslationState.FAILED,
                message: `Merge Error: ${err.message}`,
            });
        }
    }
}
