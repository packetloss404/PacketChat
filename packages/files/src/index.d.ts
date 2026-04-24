import { S3Client } from "@aws-sdk/client-s3";
export declare function getS3Client(): S3Client;
export declare function checkObjectStorage(): Promise<void>;
export declare function downloadObject(bucket: string, key: string): Promise<Buffer>;
type LocalEmbedding = {
    version: string;
    dimensions: number;
    vector: number[];
};
export declare function createLocalEmbedding(text: string): LocalEmbedding;
export declare function cosineSimilarity(a: LocalEmbedding | number[] | null | undefined, b: LocalEmbedding | number[] | null | undefined): number;
export declare function extractSupportedText(input: {
    bytes: Buffer;
    fileName?: string | null;
    mimeType?: string | null;
}): Promise<{
    text: string;
    detectedType: string;
}>;
export {};
//# sourceMappingURL=index.d.ts.map