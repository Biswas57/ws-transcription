export interface FieldDef {
    block_name: string;
    field_name: string;
}

export interface WSState {
    nchunks: number;
    audioBuffer: Buffer;
    transcript: string;
    currAttributes: Record<string, string>;
    template: FieldDef[];
    webmHeader: Buffer | null;
    currTranscriptSize: number;
}
