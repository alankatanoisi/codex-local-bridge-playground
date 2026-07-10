'use strict';

const fs = require('fs');
const path = require('path');
const safety = require('./safety');
const nativeItems = require('./items');
const { formatHint } = require('./beginner-hints');

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  // A native response is a list of typed items. Its text lives one level
  // deeper, inside each message item's content parts.
  if (content.some((item) => nativeItems.isInputItem(item))) {
    return nativeItems.extractText(content);
  }

  // Keep this small compatibility branch for archived/legacy test fixtures.
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function toolUsesFromContent(content) {
  if (!Array.isArray(content)) return [];
  if (content.some((item) => nativeItems.isFunctionCallItem(item))) {
    return nativeItems.functionCallsToPipelineToolUses(nativeItems.extractFunctionCalls(content));
  }
  return content.filter((block) => block.type === 'tool_use');
}

class HumanLog {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.verbose = !!options.verbose;
    this.quiet = !!options.quiet;
    this.provider = options.provider || nativeItems.PROVIDER;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '# Local Bridge Runner Log\n\nprovider: ' + this.provider + '\n\n');
  }

  appendSection(title, body) {
    const scrubbed = safety.scrubSecrets(body || '');
    const content = scrubbed.trim() ? scrubbed.trim() : '(empty)';
    fs.appendFileSync(this.filePath, '## ' + title + '\n\n' + content + '\n\n');
  }

  writeRunStart({ cwd, model, maxSteps, outputFormat }) {
    this.appendSection(
      'Run Started',
      ['cwd: ' + cwd, 'model: ' + model, 'max steps: ' + maxSteps, 'output format: ' + outputFormat].join('\n'),
    );
  }

  writeUserPrompt(prompt, stdinText) {
    let body = prompt || '';
    if (stdinText) {
      body += '\n\n---\nPasted context:\n' + stdinText;
    }
    this.appendSection('User Prompt', body);
  }

  writeAssistant(step, response) {
    const lines = [];
    const content = Array.isArray(response?.output) ? response.output : response?.content;
    const text = textFromContent(content);
    if (text) lines.push(text);

    const toolUses = toolUsesFromContent(content);
    if (toolUses.length > 0) {
      lines.push(
        'Tool requests:\n' +
          toolUses
            .map((toolUse) => {
              return '- ' + toolUse.name + ' ' + JSON.stringify(toolUse.input || {});
            })
            .join('\n'),
      );
    }

    this.appendSection('Assistant Turn ' + step, lines.join('\n\n'));
  }

  writeToolResult(step, toolName, toolUseId, result) {
    this.appendSection(
      'Tool Result ' + step + ' - ' + toolName,
      [
        'tool_use_id: ' + toolUseId,
        'ok: ' + !!result.ok,
        result.bytes === undefined ? null : 'bytes: ' + result.bytes,
        result.multimodal ? 'multimodal: true (image/document blocks sent to model only)' : null,
        '',
        result.text || '',
      ]
        .filter((line) => line !== null)
        .join('\n'),
    );
  }

  writeFinal(text) {
    this.appendSection('Final Answer', text || '');
  }

  writeUsage(summary) {
    if (!summary) return;
    const body = [
      'model: ' + (summary.model || 'unknown'),
      'input tokens: ' + summary.inputTokens,
      'output tokens: ' + summary.outputTokens,
      'reasoning tokens: ' + (summary.reasoningTokens || 0),
      'cache read tokens: ' + summary.cacheReadTokens,
      'cache creation tokens: ' + summary.cacheCreationTokens,
      'cache read share: ' + Math.round((summary.cacheReadShare || 0) * 100) + '%',
      'estimated cost: ~$' + (summary.costUsd || 0).toFixed(4),
    ].join('\n');
    this.appendSection('Usage & Cost', body);
  }

  writeError(message, options = {}) {
    const hint = formatHint(options.stopReason || null, {
      rawMessage: message,
      verbose: this.verbose,
      quiet: this.quiet,
    });
    let body = message || 'unknown error';
    if (!this.quiet && hint.formatted && hint.formatted !== body) {
      body += '\n\n--- Beginner hint ---\n' + hint.formatted;
    }
    this.appendSection('Error', body);
  }
}

module.exports = { HumanLog, textFromContent, toolUsesFromContent };
