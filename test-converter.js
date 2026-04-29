const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const converter = require('./converter');

describe('converter smoke test', () => {
    it('should export module', () => {
        assert.ok(converter);
    });
});

describe('convertAnthropicMessages', () => {
    const { convertAnthropicMessages } = converter;

    it('should convert simple text messages', () => {
        const messages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' }
        ];
        const result = convertAnthropicMessages(messages);
        assert.deepEqual(result, [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' }
        ]);
    });

    it('should convert content blocks to string', () => {
        const messages = [
            { role: 'user', content: [{ type: 'text', text: 'Hello' }] }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].content, 'Hello');
    });

    it('should convert image content blocks to image_url format', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'text', text: 'What is this?' },
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: 'abc123'
                        }
                    }
                ]
            }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].content[0].type, 'text');
        assert.equal(result[0].content[0].text, 'What is this?');
        const imgUrl = result[0].content[1];
        assert.equal(imgUrl.type, 'image_url');
        assert.equal(imgUrl.image_url.url, 'data:image/png;base64,abc123');
        assert.equal(imgUrl.image_url.detail, 'auto');
    });

    it('should convert image with url source', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'url',
                            url: 'https://example.com/img.png'
                        }
                    }
                ]
            }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].content[0].type, 'image_url');
        assert.equal(result[0].content[0].image_url.url, 'https://example.com/img.png');
        assert.equal(result[0].content[0].image_url.detail, 'auto');
    });

    it('should convert tool_use content to tool_calls', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool_123', name: 'get_weather', input: { city: 'London' } }
                ]
            }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].content, null);
        assert.equal(result[0].tool_calls.length, 1);
        assert.equal(result[0].tool_calls[0].id, 'tool_123');
        assert.equal(result[0].tool_calls[0].type, 'function');
        assert.equal(result[0].tool_calls[0].function.name, 'get_weather');
        assert.equal(result[0].tool_calls[0].function.arguments, '{"city":"London"}');
    });

    it('should handle assistant with only tool_use (no text) -> content null + tool_calls', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'tool_use', id: 'tool_1', name: 'search', input: { q: 'test' } },
                    { type: 'tool_use', id: 'tool_2', name: 'lookup', input: { id: 42 } }
                ]
            }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].content, null);
        assert.equal(result[0].tool_calls.length, 2);
    });

    it('should convert tool_result to tool messages', () => {
        const messages = [
            { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_123', content: 'Sunny, 22C' }] }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].role, 'tool');
        assert.equal(result[0].tool_call_id, 'tool_123');
        assert.equal(result[0].content, 'Sunny, 22C');
    });

    it('should convert tool_result with content blocks (extract text)', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: 'tool_456',
                        content: [{ type: 'text', text: 'Result: 42' }]
                    }
                ]
            }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].role, 'tool');
        assert.equal(result[0].tool_call_id, 'tool_456');
        assert.equal(result[0].content, 'Result: 42');
    });

    it('should strip thinking blocks', () => {
        const messages = [
            {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'Let me think about this...' },
                    { type: 'text', text: 'Here is my answer' }
                ]
            }
        ];
        const result = convertAnthropicMessages(messages);
        assert.equal(result[0].content, 'Here is my answer');
        assert.equal(result[0].tool_calls, undefined);
    });

    it('should handle mixed user content with tool_result and text -> multiple messages', () => {
        const messages = [
            {
                role: 'user',
                content: [
                    { type: 'tool_result', tool_use_id: 'tool_1', content: 'Result 1' },
                    { type: 'text', text: 'Now do something else' }
                ]
            }
        ];
        const result = convertAnthropicMessages(messages);
        // Should expand into multiple messages
        assert.ok(result.length >= 2);
        const toolMsg = result.find(m => m.role === 'tool');
        assert.ok(toolMsg);
        assert.equal(toolMsg.tool_call_id, 'tool_1');
        assert.equal(toolMsg.content, 'Result 1');
        const userMsg = result.find(m => m.role === 'user');
        assert.ok(userMsg);
        assert.equal(userMsg.content, 'Now do something else');
    });

    it('should handle empty messages array', () => {
        const result = convertAnthropicMessages([]);
        assert.deepEqual(result, []);
    });
});

describe('convertAnthropicTools', () => {
    const { convertAnthropicTools } = converter;

    it('should convert basic tool definition', () => {
        const tools = [{
            name: 'get_weather',
            description: 'Get current weather',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } }
        }];
        const result = convertAnthropicTools(tools);
        assert.equal(result.length, 1);
        assert.equal(result[0].type, 'function');
        assert.equal(result[0].function.name, 'get_weather');
        assert.equal(result[0].function.description, 'Get current weather');
        assert.deepEqual(result[0].function.parameters, { type: 'object', properties: { city: { type: 'string' } } });
    });

    it('should handle tools without description', () => {
        const tools = [{
            name: 'search',
            input_schema: { type: 'object', properties: { q: { type: 'string' } } }
        }];
        const result = convertAnthropicTools(tools);
        assert.equal(result[0].function.name, 'search');
        assert.equal(result[0].function.description, undefined);
        assert.ok(!('description' in result[0].function));
    });

    it('should return undefined for null input', () => {
        assert.equal(convertAnthropicTools(null), undefined);
    });

    it('should return undefined for undefined input', () => {
        assert.equal(convertAnthropicTools(undefined), undefined);
    });

    it('should return undefined for non-array input', () => {
        assert.equal(convertAnthropicTools('tools'), undefined);
    });
});

describe('convertAnthropicToolChoice', () => {
    const { convertAnthropicToolChoice } = converter;

    it('should convert "auto" to "auto"', () => {
        assert.equal(convertAnthropicToolChoice('auto'), 'auto');
    });

    it('should convert "any" to "required"', () => {
        assert.equal(convertAnthropicToolChoice('any'), 'required');
    });

    it('should convert "none" to "none"', () => {
        assert.equal(convertAnthropicToolChoice('none'), 'none');
    });

    it('should convert specific tool choice', () => {
        const result = convertAnthropicToolChoice({ type: 'tool', name: 'get_weather' });
        assert.deepEqual(result, { type: 'function', function: { name: 'get_weather' } });
    });

    it('should return undefined for null input', () => {
        assert.equal(convertAnthropicToolChoice(null), undefined);
    });

    it('should return undefined for undefined input', () => {
        assert.equal(convertAnthropicToolChoice(undefined), undefined);
    });

    it('should return undefined for unrecognized object', () => {
        assert.equal(convertAnthropicToolChoice({ type: 'unknown' }), undefined);
    });
});

describe('convertAnthropicToOpenaiRequest', () => {
    const { convertAnthropicToOpenaiRequest } = converter;

    it('should convert basic request with system prompt', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3-5-sonnet-20241022',
            system: 'You are a helpful assistant.',
            messages: [
                { role: 'user', content: 'Hello' }
            ],
            max_tokens: 1024
        });
        assert.equal(result.model, 'claude-3-5-sonnet-20241022');
        assert.equal(result.messages[0].role, 'system');
        assert.equal(result.messages[0].content, 'You are a helpful assistant.');
        assert.equal(result.messages[1].role, 'user');
        assert.equal(result.messages[1].content, 'Hello');
        assert.equal(result.max_tokens, 1024);
    });

    it('should convert system prompt as array of content blocks', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3',
            system: [
                { type: 'text', text: 'You are helpful.' },
                { type: 'text', text: 'Be concise.' }
            ],
            messages: [{ role: 'user', content: 'Hi' }]
        });
        assert.equal(result.messages[0].role, 'system');
        assert.equal(result.messages[0].content, 'You are helpful.\nBe concise.');
    });

    it('should convert stop_sequences to stop', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Hi' }],
            stop_sequences: ['\n\nHuman:', '</result>']
        });
        assert.deepEqual(result.stop, ['\n\nHuman:', '</result>']);
    });

    it('should preserve temperature and top_p', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Hi' }],
            temperature: 0.7,
            top_p: 0.9
        });
        assert.equal(result.temperature, 0.7);
        assert.equal(result.top_p, 0.9);
    });

    it('should preserve stream flag', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Hi' }],
            stream: true
        });
        assert.equal(result.stream, true);
    });

    it('should include tools when present', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Hi' }],
            tools: [{
                name: 'search',
                description: 'Search the web',
                input_schema: { type: 'object', properties: { q: { type: 'string' } } }
            }],
            tool_choice: 'auto'
        });
        assert.ok(result.tools);
        assert.equal(result.tools[0].type, 'function');
        assert.equal(result.tools[0].function.name, 'search');
        assert.equal(result.tool_choice, 'auto');
    });

    it('should not include metadata or cache_control fields', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Hi' }],
            metadata: { user_id: '123' },
            system: [{ type: 'text', text: 'Hi', cache_control: { type: 'ephemeral' } }]
        });
        assert.equal(result.metadata, undefined);
        assert.equal(result['cache_control'], undefined);
    });

    it('should handle request without system prompt', () => {
        const result = convertAnthropicToOpenaiRequest({
            model: 'claude-3',
            messages: [{ role: 'user', content: 'Hello' }]
        });
        assert.equal(result.messages[0].role, 'user');
        assert.equal(result.messages.length, 1);
    });
});

describe('convertOpenaiToAnthropicResponse', () => {
    const { convertOpenaiToAnthropicResponse } = converter;

    it('should convert simple text response', () => {
        const openaiRes = {
            id: 'chatcmpl-123',
            model: 'gpt-4',
            choices: [{
                message: { content: 'Hello', role: 'assistant' },
                finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
        };
        const result = convertOpenaiToAnthropicResponse(openaiRes);
        assert.equal(result.type, 'message');
        assert.equal(result.role, 'assistant');
        assert.equal(result.model, 'gpt-4');
        assert.equal(result.stop_reason, 'end_turn');
        assert.equal(result.stop_sequence, null);
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, 'text');
        assert.equal(result.content[0].text, 'Hello');
        assert.equal(result.usage.input_tokens, 10);
        assert.equal(result.usage.output_tokens, 5);
    });

    it('should convert tool call response', () => {
        const openaiRes = {
            id: 'chatcmpl-456',
            model: 'gpt-4',
            choices: [{
                message: {
                    role: 'assistant',
                    tool_calls: [{
                        id: 'call_abc',
                        type: 'function',
                        function: { name: 'get_weather', arguments: '{"city":"London"}' }
                    }]
                },
                finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 20, completion_tokens: 10 }
        };
        const result = convertOpenaiToAnthropicResponse(openaiRes);
        assert.equal(result.stop_reason, 'tool_use');
        assert.equal(result.content.length, 1);
        assert.equal(result.content[0].type, 'tool_use');
        assert.equal(result.content[0].id, 'call_abc');
        assert.equal(result.content[0].name, 'get_weather');
        assert.deepEqual(result.content[0].input, { city: 'London' });
    });

    it('should convert response with both text and tool calls', () => {
        const openaiRes = {
            id: 'chatcmpl-789',
            model: 'gpt-4',
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'Let me check that for you.',
                    tool_calls: [{
                        id: 'call_def',
                        type: 'function',
                        function: { name: 'search', arguments: '{"q":"test"}' }
                    }]
                },
                finish_reason: 'tool_calls'
            }],
            usage: { prompt_tokens: 15, completion_tokens: 8 }
        };
        const result = convertOpenaiToAnthropicResponse(openaiRes);
        assert.equal(result.content.length, 2);
        assert.equal(result.content[0].type, 'text');
        assert.equal(result.content[0].text, 'Let me check that for you.');
        assert.equal(result.content[1].type, 'tool_use');
        assert.equal(result.content[1].name, 'search');
    });

    it('should map finish_reason: stop→end_turn, length→max_tokens, tool_calls→tool_use', () => {
        const cases = [
            { finish_reason: 'stop', expected: 'end_turn' },
            { finish_reason: 'length', expected: 'max_tokens' },
            { finish_reason: 'tool_calls', expected: 'tool_use' },
            { finish_reason: 'content_filter', expected: 'end_turn' }
        ];
        for (const { finish_reason, expected } of cases) {
            const res = convertOpenaiToAnthropicResponse({
                id: 'chatcmpl-1', model: 'gpt-4',
                choices: [{ message: { content: 'x', role: 'assistant' }, finish_reason }],
                usage: { prompt_tokens: 1, completion_tokens: 1 }
            });
            assert.equal(res.stop_reason, expected, `finish_reason=${finish_reason}`);
        }
    });

    it('should convert reasoning_content as thinking block', () => {
        const openaiRes = {
            id: 'chatcmpl-think',
            model: 'gpt-4',
            choices: [{
                message: {
                    role: 'assistant',
                    reasoning_content: 'Let me think about this...',
                    content: 'Here is my answer'
                },
                finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 10, completion_tokens: 20 }
        };
        const result = convertOpenaiToAnthropicResponse(openaiRes);
        assert.equal(result.content.length, 2);
        assert.equal(result.content[0].type, 'thinking');
        assert.equal(result.content[0].thinking, 'Let me think about this...');
        assert.equal(result.content[1].type, 'text');
        assert.equal(result.content[1].text, 'Here is my answer');
    });

    it('should map usage tokens correctly', () => {
        const openaiRes = {
            id: 'chatcmpl-usage',
            model: 'gpt-4',
            choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: 50 }
        };
        const result = convertOpenaiToAnthropicResponse(openaiRes);
        assert.equal(result.usage.input_tokens, 100);
        assert.equal(result.usage.output_tokens, 50);
    });

    it('should generate id with msg_ prefix', () => {
        const openaiRes = {
            id: 'chatcmpl-idtest',
            model: 'gpt-4',
            choices: [{ message: { content: 'Hi', role: 'assistant' }, finish_reason: 'stop' }],
            usage: {}
        };
        const result = convertOpenaiToAnthropicResponse(openaiRes);
        assert.ok(result.id.startsWith('msg_'));
        assert.ok(result.id.length > 4);
    });

    it('should handle tool_calls with invalid JSON arguments', () => {
        const openaiRes = {
            id: 'chatcmpl-badjson',
            model: 'gpt-4',
            choices: [{
                message: {
                    role: 'assistant',
                    tool_calls: [{
                        id: 'call_xyz',
                        type: 'function',
                        function: { name: 'test', arguments: 'not-json' }
                    }]
                },
                finish_reason: 'tool_calls'
            }],
            usage: {}
        };
        const result = convertOpenaiToAnthropicResponse(openaiRes);
        assert.deepEqual(result.content[0].input, {});
    });
});

describe('createAnthropicStreamTransformer', () => {
    const { createAnthropicStreamTransformer } = converter;
    const { Readable } = require('stream');

    async function collectStream(readable) {
        const chunks = [];
        for await (const chunk of readable) { chunks.push(chunk.toString()); }
        return chunks.join('');
    }

    function parseSSEEvents(raw) {
        const events = [];
        const blocks = raw.split('\n\n').filter(b => b.trim());
        for (const block of blocks) {
            const lines = block.split('\n');
            let eventType = 'message';
            let data = '';
            for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7);
                if (line.startsWith('data: ')) data = line.slice(6);
            }
            if (data) events.push({ event: eventType, data: JSON.parse(data) });
        }
        return events;
    }

    function makeSSE(data) {
        return `data: ${JSON.stringify(data)}\n\n`;
    }

    it('should convert simple text streaming', async () => {
        const chunks = [
            { choices: [{ delta: { content: 'Hello' } }] },
            { choices: [{ delta: { content: ' world' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] }
        ];
        const input = Readable.from(chunks.map(makeSSE));
        const transformer = createAnthropicStreamTransformer('gpt-4', 10);
        const output = await collectStream(input.pipe(transformer));
        const events = parseSSEEvents(output);

        // Verify event sequence
        const types = events.map(e => e.event);
        assert.ok(types.includes('message_start'), 'should have message_start');
        assert.ok(types.includes('content_block_start'), 'should have content_block_start');
        assert.ok(types.includes('content_block_delta'), 'should have content_block_delta');
        assert.ok(types.includes('content_block_stop'), 'should have content_block_stop');
        assert.ok(types.includes('message_delta'), 'should have message_delta');
        assert.ok(types.includes('message_stop'), 'should have message_stop');

        // Verify order: message_start first, message_stop last
        assert.equal(types[0], 'message_start');
        assert.equal(types[types.length - 1], 'message_stop');

        // Verify message_start structure
        const msgStart = events.find(e => e.event === 'message_start');
        assert.equal(msgStart.data.type, 'message_start');
        assert.equal(msgStart.data.message.model, 'gpt-4');
        assert.equal(msgStart.data.message.usage.input_tokens, 10);

        // Verify content_block_start has text type
        const blockStart = events.find(e => e.event === 'content_block_start');
        assert.equal(blockStart.data.content_block.type, 'text');

        // Verify text delta content
        const deltas = events.filter(e => e.event === 'content_block_delta');
        assert.equal(deltas[0].data.delta.text, 'Hello');
        assert.equal(deltas[1].data.delta.text, ' world');

        // Verify message_delta has stop_reason
        const msgDelta = events.find(e => e.event === 'message_delta');
        assert.equal(msgDelta.data.delta.stop_reason, 'end_turn');
    });

    it('should convert tool call streaming', async () => {
        const chunks = [
            { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'get_weather', arguments: '' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"ci' } }] } }] },
            { choices: [{ delta: { tool_calls: [{ function: { arguments: 'ty":"London"}' } }] } }] },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
        ];
        const input = Readable.from(chunks.map(makeSSE));
        const transformer = createAnthropicStreamTransformer('gpt-4', 10);
        const output = await collectStream(input.pipe(transformer));
        const events = parseSSEEvents(output);

        const types = events.map(e => e.event);
        // Should have tool_use content block start
        const blockStart = events.find(e => e.event === 'content_block_start');
        assert.equal(blockStart.data.content_block.type, 'tool_use');
        assert.equal(blockStart.data.content_block.name, 'get_weather');
        assert.equal(blockStart.data.content_block.id, 'call_1');

        // Should have input_json_delta chunks
        const jsonDeltas = events.filter(e =>
            e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta'
        );
        assert.ok(jsonDeltas.length >= 2, 'should have multiple input_json_delta events');

        // Verify stop_reason is tool_use
        const msgDelta = events.find(e => e.event === 'message_delta');
        assert.equal(msgDelta.data.delta.stop_reason, 'tool_use');
    });

    it('should convert reasoning_content as thinking blocks', async () => {
        const chunks = [
            { choices: [{ delta: { reasoning_content: 'Thinking...' } }] },
            { choices: [{ delta: { reasoning_content: ' More thought.' } }] },
            { choices: [{ delta: { content: 'Answer' } }] },
            { choices: [{ delta: {}, finish_reason: 'stop' }] }
        ];
        const input = Readable.from(chunks.map(makeSSE));
        const transformer = createAnthropicStreamTransformer('gpt-4', 5);
        const output = await collectStream(input.pipe(transformer));
        const events = parseSSEEvents(output);

        // Should have thinking content block start
        const blockStarts = events.filter(e => e.event === 'content_block_start');
        assert.equal(blockStarts.length, 2, 'should have 2 content blocks (thinking + text)');

        assert.equal(blockStarts[0].data.content_block.type, 'thinking');
        assert.equal(blockStarts[1].data.content_block.type, 'text');

        // Verify thinking deltas
        const thinkingDeltas = events.filter(e =>
            e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta'
        );
        assert.equal(thinkingDeltas.length, 2);
        assert.equal(thinkingDeltas[0].data.delta.thinking, 'Thinking...');
        assert.equal(thinkingDeltas[1].data.delta.thinking, ' More thought.');

        // Verify text delta
        const textDeltas = events.filter(e =>
            e.event === 'content_block_delta' && e.data.delta.type === 'text_delta'
        );
        assert.equal(textDeltas.length, 1);
        assert.equal(textDeltas[0].data.delta.text, 'Answer');
    });

    it('should handle [DONE] marker', async () => {
        const chunks = [
            { choices: [{ delta: { content: 'Hi' } }] }
        ];
        const sseData = chunks.map(makeSSE).join('') + 'data: [DONE]\n\n';
        const input = Readable.from([sseData]);
        const transformer = createAnthropicStreamTransformer('gpt-4', 10);
        const output = await collectStream(input.pipe(transformer));
        const events = parseSSEEvents(output);

        const types = events.map(e => e.event);
        assert.ok(types.includes('message_stop'), 'should have message_stop after [DONE]');
    });
});

describe('convertOpenaiErrorToAnthropic', () => {
    const { convertOpenaiErrorToAnthropic } = converter;

    it('should convert OpenAI error format to Anthropic format', () => {
        const result = convertOpenaiErrorToAnthropic(
            { error: { message: 'Invalid API key', type: 'invalid_request_error', code: 'invalid_api_key' } },
            401
        );
        assert.equal(result.type, 'error');
        assert.equal(result.error.type, 'invalid_request_error');
        assert.equal(result.error.message, 'Invalid API key');
    });

    it('should handle missing error fields with defaults', () => {
        const result = convertOpenaiErrorToAnthropic(
            { error: {} },
            500
        );
        assert.equal(result.type, 'error');
        assert.equal(result.error.type, 'api_error');
        assert.equal(result.error.message, 'Unknown error');
    });

    it('should create error from status code alone', () => {
        const cases = [
            { statusCode: 400, expectedType: 'invalid_request_error' },
            { statusCode: 401, expectedType: 'authentication_error' },
            { statusCode: 403, expectedType: 'permission_error' },
            { statusCode: 404, expectedType: 'not_found_error' },
            { statusCode: 429, expectedType: 'rate_limit_error' },
            { statusCode: 500, expectedType: 'api_error' },
            { statusCode: 502, expectedType: 'api_error' },
            { statusCode: 503, expectedType: 'overloaded_error' }
        ];
        for (const { statusCode, expectedType } of cases) {
            const result = convertOpenaiErrorToAnthropic(null, statusCode);
            assert.equal(result.error.type, expectedType, `statusCode=${statusCode}`);
            assert.equal(result.error.message, `HTTP ${statusCode}`);
        }
    });

    it('should handle null error and null statusCode', () => {
        const result = convertOpenaiErrorToAnthropic(null, null);
        assert.equal(result.type, 'error');
        assert.equal(result.error.type, 'api_error');
        assert.equal(result.error.message, 'Unknown error');
    });
});
