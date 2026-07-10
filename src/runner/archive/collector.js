'use strict';

/**
 * In-memory collector for live runs — flushed by finalizeArchiveExport.
 */

const nativeItems = require('../items');

class RunArchiveCollector {
  constructor(meta) {
    this.meta = {
      runId: meta.runId,
      sessionId: meta.sessionId ?? null,
      cwd: meta.cwd,
      model: meta.model,
      prompt: meta.prompt,
      stdinText: meta.stdinText,
      flags: meta.flags || {},
      agentProfile: meta.agentProfile ?? null,
      transcriptPath: meta.transcriptPath ?? null,
      tracePath: meta.tracePath ?? null,
      sessionPath: meta.sessionPath ?? null,
      ledgerPath: meta.ledgerPath ?? null,
      startedAt: meta.startedAt || new Date().toISOString(),
      source: meta.source || 'live',
      provider: meta.provider || nativeItems.PROVIDER,
      coordinator: meta.coordinator || null,
    };
    this.turns = [];
    this._seq = 0;
    this.outcome = null;
  }

  nextSeq() {
    this._seq += 1;
    return this._seq;
  }

  recordUser(prompt, stdinText) {
    const seq = this.nextSeq();
    this.turns.push({
      seq,
      kind: 'user',
      step: 0,
      input: { prompt: prompt || '', stdinText: stdinText || '' },
      output: {},
    });
  }

  recordAssistant(step, response) {
    const seq = this.nextSeq();
    const content = Array.isArray(response?.output) ? response.output : response?.content;
    const isNative = Array.isArray(content) && content.some((item) => nativeItems.isInputItem(item));
    const text = isNative
      ? nativeItems.extractText(content)
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : typeof content === 'string'
          ? content
          : '';
    const functionCalls = isNative
      ? nativeItems.extractFunctionCalls(content).map((call) => ({
          call_id: call.call_id,
          name: call.name,
          arguments: call.arguments,
        }))
      : [];
    const toolUses =
      !isNative && Array.isArray(content)
        ? content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, input: b.input }))
        : [];
    this.turns.push({
      seq,
      kind: 'assistant',
      step,
      input: { model: this.meta.model },
      // Keep legacy toolUses only for imported old logs. New live turns store
      // native function-call fields without translating them back to Anthropic.
      output: isNative ? { text, functionCalls } : { text, toolUses },
    });
  }

  recordTool(step, toolName, toolUseId, args, result) {
    const seq = this.nextSeq();
    const text = result?.text || '';
    this.turns.push({
      seq,
      kind: 'tool',
      step,
      toolName,
      toolUseId,
      input: { args: args || {} },
      output: {
        ok: !!result?.ok,
        text,
        // `bytes` is the tool's native size signal. For read_file that is the
        // source file size, while `resultBytes` is what actually went back to
        // the model. Keeping both prevents sliced reads from looking like full
        // file reads during archive forensics.
        bytes: result?.bytes,
        resultBytes: Buffer.byteLength(text, 'utf8'),
        partial: !!result?.partial,
        truncated: !!result?.truncated,
        offset: result?.offset,
        summarized: !!result?.summarized,
        droppedBytes: result?.droppedBytes,
        loopWarning: result?.loopWarning || null,
        needsConfirmation: !!result?.needsConfirmation,
        permission: result?.permission || null,
      },
    });
  }

  recordFinal(text) {
    const seq = this.nextSeq();
    this.turns.push({
      seq,
      kind: 'final',
      step: null,
      input: {},
      output: { text: text || '' },
    });
  }

  recordError(step, message) {
    const seq = this.nextSeq();
    this.turns.push({
      seq,
      kind: 'error',
      step,
      input: {},
      output: { message: message || '' },
    });
  }

  setOutcome(patch) {
    this.outcome = {
      stopReason: patch.stopReason,
      finalText: patch.finalText,
      steps: patch.steps,
      duration_ms: patch.duration_ms,
      usage: patch.usage || {},
      estimatedCostUsd: patch.estimatedCostUsd ?? null,
    };
  }
}

function isArchiveEnabled(options = {}) {
  if (options.noArchive) return false;
  if (process.env.BRIDGE_RUNNER_ARCHIVE === '0') return false;
  return true;
}

module.exports = {
  RunArchiveCollector,
  isArchiveEnabled,
};
