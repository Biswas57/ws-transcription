// Cost monitoring utility for tracking API usage and expenses
export interface CostTracker {
    whisperCalls: number;
    gptCalls: { model: string; tokens: number; }[];
    totalEstimatedCost: number;
}

// Rough cost estimates (as of 2024 - should be updated regularly)
const PRICING = {
    'whisper-1': 0.006, // per minute
    'gpt-4o-mini': 0.00015, // per 1K tokens (input) + 0.0006 (output)
    'gpt-4o': 0.005, // per 1K tokens (input) + 0.015 (output)
    'gpt-4.1': 0.01, // per 1K tokens (rough estimate)
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
    if (model.includes('gpt-4o-mini')) {
        cost = (inputTokens * 0.00015 + outputTokens * 0.0006) / 1000;
    } else if (model.includes('gpt-4o')) {
        cost = (inputTokens * 0.005 + outputTokens * 0.015) / 1000;
    } else if (model.includes('gpt-4.1')) {
        cost = (inputTokens + outputTokens) * 0.01 / 1000;
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
