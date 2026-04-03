// Cost monitoring utility for tracking API usage and expenses
export interface CostTracker {
    whisperCalls: number;
    gptCalls: { model: string; tokens: number; }[];
    totalEstimatedCost: number;
}

// Rough cost estimates from the current OpenAI model pricing page (updated 2026-04)
const PRICING = {
    'whisper-1': 0.006, // per minute
    'gpt-5.4-mini-input': 0.00075, // $0.75 / 1M input tokens
    'gpt-5.4-mini-output': 0.0045, // $4.50 / 1M output tokens
    'gpt-5.4-input': 0.0025, // $2.50 / 1M input tokens
    'gpt-5.4-output': 0.015, // $15.00 / 1M output tokens
};

const costTracker: CostTracker = {
    whisperCalls: 0,
    gptCalls: [],
    totalEstimatedCost: 0
};

export function trackWhisperCall(audioSizeBytes: number): void {
    costTracker.whisperCalls++;
    // Rough estimate: 1MB ≈ 1 minute of audio
    const estimatedMinutes = audioSizeBytes / (1024 * 1024);
    const cost = estimatedMinutes * PRICING['whisper-1'];
    costTracker.totalEstimatedCost += cost;

    console.log(`Whisper call tracked: ~${estimatedMinutes.toFixed(2)} min, ~$${cost.toFixed(4)}`);
}

export function trackGPTCall(model: string, inputTokens: number, outputTokens: number): void {
    costTracker.gptCalls.push({ model, tokens: inputTokens + outputTokens });

    let cost = 0;
    if (model.includes('gpt-5.4-mini')) {
        cost = (
            inputTokens * PRICING['gpt-5.4-mini-input'] +
            outputTokens * PRICING['gpt-5.4-mini-output']
        ) / 1000;
    } else if (model.includes('gpt-5.4')) {
        cost = (
            inputTokens * PRICING['gpt-5.4-input'] +
            outputTokens * PRICING['gpt-5.4-output']
        ) / 1000;
    }

    costTracker.totalEstimatedCost += cost;
    console.log(`GPT call tracked: ${model}, ${inputTokens + outputTokens} tokens, ~$${cost.toFixed(4)}`);
}

export function getCostSummary(): CostTracker & { avgCostPerWhisperCall: number; avgCostPerGPTCall: number } {
    const avgCostPerWhisperCall = costTracker.whisperCalls > 0 ?
        (costTracker.whisperCalls * PRICING['whisper-1']) / costTracker.whisperCalls : 0;

    const avgCostPerGPTCall = costTracker.gptCalls.length > 0 ?
        costTracker.totalEstimatedCost / (costTracker.whisperCalls + costTracker.gptCalls.length) : 0;

    return {
        ...costTracker,
        avgCostPerWhisperCall,
        avgCostPerGPTCall
    };
}

export function resetCostTracker(): void {
    costTracker.whisperCalls = 0;
    costTracker.gptCalls = [];
    costTracker.totalEstimatedCost = 0;
}

// Log cost summary every 10 minutes
setInterval(() => {
    const summary = getCostSummary();
    if (summary.whisperCalls > 0 || summary.gptCalls.length > 0) {
        console.log('=== COST SUMMARY ===');
        console.log(`Whisper calls: ${summary.whisperCalls}`);
        console.log(`GPT calls: ${summary.gptCalls.length}`);
        console.log(`Total estimated cost: $${summary.totalEstimatedCost.toFixed(4)}`);
        console.log('==================');
    }
}, 10 * 60 * 1000);
