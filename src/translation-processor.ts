import {
    AttachmentSchema,
    create,
    PayloadSchema,
    translationCapability,
    TranslationSessionContext,
    TranslationSessionProcessor,
    TranslationState
} from "testgenesis-client-node";

import type {ProjectShape} from "@seleniumhq/side-model";

/**
 * Singleton handler for SIDE project translation jobs.
 */
export class TranslationProcessor implements TranslationSessionProcessor {
    public getCapability() {
        return translationCapability({
            type: "selenium-ide-project-to-test",
            sourcePayloads: [{
                type: "selenium-side-project",
                isRequired: true,
                acceptedMimeTypes: ["application/octet-stream"]
            }],
            targetPayloads: [{
                type: "selenium-side",
                isRequired: true,
                isRepeatable: true,
                acceptedMimeTypes: ["application/json"]
            }]
        });
    }

    public async process(sessionId: string, context: TranslationSessionContext) {
        try {
            const init = context.init;
            await context.sendStatus({
                state: TranslationState.ACKNOWLEDGED,
                message: "Starting SIDE project decomposition..."
            });

            const sourcePayload = init.payloads[0];
            if (!sourcePayload?.attachment) {
                await context.sendStatus({
                    state: TranslationState.FAILED,
                    message: "No source SIDE project attachment found"
                });
                return;
            }

            const project: ProjectShape = JSON.parse(new TextDecoder().decode(sourcePayload.attachment.data));
            await context.sendTelemetry(`Parsing project: ${project.name}`);
            await context.sendStatus({
                state: TranslationState.PROCESSING,
                message: `Extracting ${project.tests.length} tests...`
            });

            const results = [];
            for (const test of project.tests) {
                await context.sendTelemetry(`Extracted test: ${test.name}`);
                results.push(create(PayloadSchema, {
                    type: "selenium-side",
                    attachment: create(AttachmentSchema, {
                        name: `${test.name}.json`,
                        mimeType: "application/json",
                        data: new TextEncoder().encode(JSON.stringify(test))
                    })
                }));
            }

            await context.sendResult({
                status: {state: TranslationState.COMPLETED},
                payloads: results
            });
            await context.sendStatus({
                state: TranslationState.COMPLETED,
                message: `Successfully split into ${results.length} tests.`
            });
        } catch (err: any) {
            console.error(`[Translate ${sessionId}] Error:`, err);
            await context.sendStatus({
                state: TranslationState.FAILED,
                message: `Translation Error: ${err.message}`
            });
        }
    }
}
