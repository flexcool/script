
// ==UserScript==
// @name         DeepSeek qwen-code Enhanced Auto Send (Optimized + Direct Reply)
// @namespace    http://tampermonkey.net/
// @version      0.8
// @description  SSE监控 + MCP客户端（修复 SSE 流结束时最后数据丢失 + 缓冲区未刷新的时序 bug）
// @author       Your Name
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      mcp.api-inference.modelscope.net
// ==/UserScript==

window.shouldSendAfterStream = false;
window.commandResults = '';
window.MCP_SEND_PLACEHOLDER = '发送命令xxxoooxxx';

(function() {
    'use strict';

    // ================= [保留] 弹窗覆盖层逻辑 =================
    let overlay = null;
    let overlayText = null;

    function createOverlay() {
        if (overlay) return;
        overlay = document.createElement('div');
        overlay.id = 'mcp-overlay';
        overlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100%; height: 100%; background-color: rgba(0, 0, 0, 0.7); display: none; justify-content: center; align-items: center; z-index: 9999; font-family: Arial, sans-serif; color: white; font-size: 18px; text-align: center;`;
        overlayText = document.createElement('div');
        overlayText.id = 'mcp-overlay-text';
        overlayText.innerHTML = '🔄 MCP命令调用中...<br>等待返回结果';
        overlayText.style.cssText = `background-color: rgba(0, 0, 0, 0.8); padding: 20px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.5); position: relative;`;

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '×';
        closeBtn.style.cssText = `position: absolute; top: 8px; right: 12px; background: transparent; border: none; color: #fff; font-size: 20px; cursor: pointer;`;
        closeBtn.addEventListener('click', hideOverlay);
        overlayText.appendChild(closeBtn);

        overlay.appendChild(overlayText);
        document.body.appendChild(overlay);
    }

    function showOverlay() { if (!overlay) createOverlay(); overlay.style.display = 'flex'; }
    function hideOverlay() { if (overlay) overlay.style.display = 'none'; }

    // ================= [优化] 手动触发面板逻辑 =================
    let panelVisible = false;

    function createManualPanel() {
        if (document.getElementById('mcp-manual-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'mcp-manual-panel';
        panel.style.cssText = `
            position: fixed; top: 65px; right: 20px; z-index: 10001;
            background: #1e1e1e; color: #d1d5db; border: 1px solid #374151;
            border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
            padding: 16px; width: 380px; display: none; font-family: system-ui, -apple-system, sans-serif;
        `;
        panel.innerHTML = `
            <div style="font-size: 14px; font-weight: 600; margin-bottom: 10px; color: #f3f4f6; display: flex; align-items: center; gap: 6px;">
                <span>⚡</span> 手动触发 MCP 工具
            </div>
            <textarea id="mcp-manual-input" placeholder='例如: start{"name":"get_role_card","arguments":{}}end'
                style="width: 100%; height: 90px; background: #111827; border: 1px solid #374151; border-radius: 8px; padding: 10px; font-size: 13px; color: #e5e7eb; resize: vertical; box-sizing: border-box; outline: none; transition: border-color 0.2s;"></textarea>
            <button id="mcp-manual-submit" style="
                margin-top: 10px; width: 100%; padding: 10px; background-color: #374151; color: #f9fafb;
                border: 1px solid #4b5563; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.2s;
            ">执行并直接回复</button>
            <div id="mcp-manual-msg" style="margin-top: 8px; font-size: 12px; color: #9ca3af; word-break: break-all; max-height: 120px; overflow-y: auto; line-height: 1.4;"></div>
        `;
        document.body.appendChild(panel);

        const input = document.getElementById('mcp-manual-input');
        input.addEventListener('focus', () => input.style.borderColor = '#60a5fa');
        input.addEventListener('blur', () => input.style.borderColor = '#374151');

        document.getElementById('mcp-manual-submit').addEventListener('click', async () => {
            const msgDiv = document.getElementById('mcp-manual-msg');
            const submitBtn = document.getElementById('mcp-manual-submit');
            const rawText = input.value.trim();

            if (!rawText) {
                msgDiv.style.color = '#f87171';
                msgDiv.textContent = '输入内容不能为空';
                return;
            }

            // 【修复】手动面板也使用 findToolCallMarkers，保持一致的检测逻辑
            const markers = findToolCallMarkers(rawText);
            if (markers.length === 0) {
                msgDiv.style.color = '#f87171';
                msgDiv.textContent = '格式错误，请确保包含 start{...}end 或 start:{...}end';
                return;
            }

            try {
                const toolData = markers[0].jsonContent;
                if (!toolData.name) throw new Error('缺少 name 字段');

                msgDiv.style.color = '#60a5fa';
                msgDiv.textContent = '⏳ 正在执行...';
                submitBtn.disabled = true;
                submitBtn.style.opacity = '0.7';

                const result = await execstart(toolData.name, toolData.arguments || {});

                let replyText = "";
                if (result.success) {
                    replyText = result.result?.content?.[0]?.text || result.result?.stdout || JSON.stringify(result.result);
                    msgDiv.style.color = '#34d399';
                    msgDiv.textContent = '✅ 执行成功，正在发送回复...';
                } else {
                    replyText = `❌ 工具 ${toolData.name} 执行失败: ${result.error}`;
                    msgDiv.style.color = '#f87171';
                    msgDiv.textContent = replyText;
                }

                if (replyText) {
                    simulateTypeAndSend(replyText);
                }

                input.value = '';
            } catch (e) {
                msgDiv.style.color = '#f87171';
                msgDiv.textContent = '❌ 解析或执行异常: ' + e.message;
            } finally {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }
        });
    }

    function toggleManualPanel() {
        panelVisible = !panelVisible;
        const panel = document.getElementById('mcp-manual-panel');
        if (panel) panel.style.display = panelVisible ? 'block' : 'none';
    }

    // ================= [保留] 初始化按钮逻辑 =================
    function createInitButton() {
        const container = document.createElement('div');
        container.id = 'mcp-btn-container';
        container.style.cssText = `position: fixed; top: 20px; right: 20px; z-index: 10002; display: flex; gap: 8px; font-family: system-ui, -apple-system, sans-serif;`;

        const initBtn = document.createElement('div');
        initBtn.innerHTML = '🔄 初始化';
        initBtn.style.cssText = `
            background-color: #374151; color: #f9fafb; padding: 8px 14px;
            border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2); transition: background 0.2s; user-select: none; border: 1px solid #4b5563;
        `;
        initBtn.addEventListener('mouseenter', () => initBtn.style.backgroundColor = '#4b5563');
        initBtn.addEventListener('mouseleave', () => initBtn.style.backgroundColor = '#374151');
        initBtn.addEventListener('click', () => {
            initializeMCP();
            initBtn.innerHTML = '✅ 已初始化';
            setTimeout(() => { initBtn.innerHTML = '🔄 初始化'; }, 2000);
        });

        const toggleBtn = document.createElement('div');
        toggleBtn.innerHTML = '⚡ 手动';
        toggleBtn.style.cssText = `
            background-color: #374151; color: #f9fafb; padding: 8px 14px;
            border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2); transition: background 0.2s; user-select: none; border: 1px solid #4b5563;
        `;
        toggleBtn.addEventListener('mouseenter', () => toggleBtn.style.backgroundColor = '#4b5563');
        toggleBtn.addEventListener('mouseleave', () => {
            toggleBtn.style.backgroundColor = panelVisible ? '#2563eb' : '#374151';
        });
        toggleBtn.addEventListener('click', () => {
            createManualPanel();
            toggleManualPanel();
            toggleBtn.style.backgroundColor = panelVisible ? '#2563eb' : '#374151';
        });

        container.appendChild(initBtn);
        container.appendChild(toggleBtn);
        document.body.appendChild(container);
    }

    // ================= [保留] 模拟输入与发送逻辑 =================
    function simulateTypeAndSend(message) {
        if (window.isAutoSending) return;
        window.isAutoSending = true;
        const textarea = document.querySelector('textarea._27c9245') || document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
        if (!textarea) { window.isAutoSending = false; return; }

        textarea.focus();
        const isPlaceholder = message === window.MCP_SEND_PLACEHOLDER;
        const fullMsg = isPlaceholder ? message : (window.commandResults ? (window.commandResults + "\n" + message) : message);
        if (!isPlaceholder) window.commandResults = '';

        if (textarea.isContentEditable) {
            textarea.innerHTML = '';
            document.execCommand('insertText', false, fullMsg);
        } else {
            const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(textarea), 'value')?.set;
            if (nativeSetter) nativeSetter.call(textarea, fullMsg);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }

        setTimeout(() => {
            const sendButtons = Array.from(document.querySelectorAll('div[role="button"]'))
                .filter(btn => btn.querySelector('svg path')?.getAttribute('d')?.includes('V15.0431'));
            if (sendButtons.length > 0) {
                sendButtons[0].click();
            } else {
                textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
            }
            setTimeout(() => { window.isAutoSending = false; }, 300);
        }, 300);
    }

    // ================= [保留] 初始化函数 =================
    function initializeMCP() {
        window.commandResults = '\n📊 MCP初始化成功\n---\n正在获取角色卡...\n---\n';
        simulateTypeAndSend(window.MCP_SEND_PLACEHOLDER);

        executeTool('get_role_card', {}).then(() => {
            console.log('✅ 角色卡获取完成');
        }).catch(e => {
            console.error('❌ 角色卡获取失败:', e);
        });
    }

    // ================= [核心修复 v0.7] 工具调用检测逻辑 =================
    let activeToolCalls = [];

    /**
     * findToolCallMarkers v0.6 - 三处关键修复：
     *
     * 修复1: 移除 end 后的 (?!\w) 断言
     *   原来: /^\s*end(?!\w)/ → "endstart" 中 "end" 后面是 's' (word char) → 匹配失败
     *   现在: /^\s*end/ → "endstart" 中 "end" 正常匹配，不再被后面的 "start" 阻断
     *
     * 修复2: 花括号计数感知 JSON 字符串
     *   原来: 纯粹数 { 和 }，字符串内的 } 会导致提前结束
     *   现在: 跟踪 inString 和 escape 状态，字符串内的花括号被忽略
     *
     * 修复3: 词边界检查兼容 "endstart" 场景
     *   原来: 前一个字符是字母就跳过（会误杀 "endstart" 中的第二个 start）
     *   现在: 前三个字符恰好是 "end" 时允许匹配，其他字母前缀（如 "restart"）仍跳过
     */
    function findToolCallMarkers(text) {
        const markers = [];
        const startTagRegex = /start:?\s*\{/g;
        let tagMatch;

        while ((tagMatch = startTagRegex.exec(text)) !== null) {
            const startIndex = tagMatch.index;

            // 【修复3】词边界检查：防止 "restart{" 误匹配，但允许 "endstart{"
            if (startIndex > 0 && /[a-zA-Z]/.test(text[startIndex - 1])) {
                // 如果前面恰好是 "end" 关键词，允许匹配（连续标记场景）
                if (startIndex >= 3 && text.substring(startIndex - 3, startIndex).toLowerCase() === 'end') {
                    // OK: "endstart{" 是合法的连续标记
                } else {
                    // 跳过: "restart{"、"upstart{" 等
                    continue;
                }
            }

            // 找到 '{' 的位置
            const braceStart = text.indexOf('{', tagMatch.index);
            if (braceStart === -1) continue;

            // 【修复2】字符串感知花括号计数
            let depth = 0;
            let jsonEnd = -1;
            let inString = false;
            let escape = false;

            for (let i = braceStart; i < text.length; i++) {
                const ch = text[i];

                if (escape) {
                    escape = false;
                    continue;
                }

                if (ch === '\\' && inString) {
                    escape = true;
                    continue;
                }

                if (ch === '"') {
                    inString = !inString;
                    continue;
                }

                if (!inString) {
                    if (ch === '{') depth++;
                    else if (ch === '}') {
                        depth--;
                        if (depth === 0) {
                            jsonEnd = i + 1;
                            break;
                        }
                    }
                }
            }

            if (jsonEnd === -1) continue; // 花括号未闭合

            // 检查 '}' 后面是否紧跟 'end'
            const afterBrace = text.substring(jsonEnd);
            // 【修复1】移除 (?!\w)！这是 "隔一个漏一个" 的直接原因
            // 当 LLM 输出 start{A}endstart{B}end 时，
            // 原来的 (?!\w) 会因为 "end" 后面紧跟 "s" 而匹配失败
            const endMatch = afterBrace.match(/^\s*end/);
            if (!endMatch) continue;

            const endIndex = jsonEnd + endMatch[0].length;
            const jsonContent = text.substring(braceStart, jsonEnd);

            try {
                const parsedArgs = JSON.parse(jsonContent);
                markers.push({ start: startIndex, end: endIndex, jsonContent: parsedArgs });
                // 跳到当前 marker 结束之后继续搜索
                startTagRegex.lastIndex = endIndex;
            } catch (e) {
                console.warn("[MCP] 无效JSON的start/end块:", jsonContent, e.message);
                // exec 已经自动推进了 lastIndex，继续搜索
            }
        }
        return markers;
    }

    function checkToolCalls(state) {
        const currentContent = state.contentAccumulator;
        const potentialMarkers = findToolCallMarkers(currentContent);
        const newMarkers = potentialMarkers.filter(marker => marker.start >= (state.lastProcessedIndex || 0));

        if (newMarkers.length > 0) {
            console.log(`[MCP v0.8] 检测到 ${newMarkers.length} 个新工具调用:`, newMarkers.map(m => m.jsonContent.name),
                `| lastProcessedIndex=${state.lastProcessedIndex} | 总标记数=${potentialMarkers.length} | 内容长度=${currentContent.length}`);
        }
        // 诊断日志：即使没有新 marker，如果有潜在标记也输出
        if (newMarkers.length === 0 && potentialMarkers.length > 0) {
            console.log(`[MCP v0.8] 发现 ${potentialMarkers.length} 个标记但都被过滤（已处理过）`,
                potentialMarkers.map(m => ({name: m.jsonContent.name, start: m.start, filtered: m.start < (state.lastProcessedIndex||0)})));
        }

        // 从后往前处理，替换后面的不影响前面的位置
        for (let i = newMarkers.length - 1; i >= 0; i--) {
            const marker = newMarkers[i];
            const toolData = marker.jsonContent;
            if (!toolData || !toolData.name) continue;

            console.log("[MCP] 自动执行工具:", toolData.name, toolData.arguments);
            executeTool(toolData.name, toolData.arguments || {});

            const replacement = `\n[PROCESSED_MCP_CALL:${toolData.name}]\n`;
            state.contentAccumulator = state.contentAccumulator.substring(0, marker.start)
                + replacement
                + state.contentAccumulator.substring(marker.end);
        }

        // 【核心修复 v0.7】安全更新 lastProcessedIndex
        //
        // 原来的 bug：处理完 marker 后直接把 lastProcessedIndex 设为 contentAccumulator.length。
        // 当 SSE 流中两个工具调用紧挨着输出时（如 start{A}end ... start{B}），
        // A 的 "end" 和 B 的 "start{...}" 可能在同一个 chunk 中到达。
        // 此时 A 被处理并替换，但 B 只有 "start{...}" 还没有 "end"（不完整 marker）。
        // 原代码把 lastProcessedIndex 设为 content 末尾（已经超过了 B 的 start 位置），
        // 导致下一个 chunk 中 B 的 "end" 到达时，B.start < lastProcessedIndex → 被过滤掉！
        // 这就是"隔一个漏一个"的真正原因。
        //
        // 修复：扫描剩余内容中是否还有 "start" 标签（可能是不完整 marker），
        // 如果有，lastProcessedIndex 设为该位置，确保后续 "end" 到达时能重新检测到。
        if (newMarkers.length > 0) {
            const firstStartRegex = /start:?\s*\{/;
            const firstStartMatch = state.contentAccumulator.match(firstStartRegex);
            if (firstStartMatch) {
                // 还有 "start" 标签存在（可能是未完整的 marker），从该位置开始重新检查
                state.lastProcessedIndex = firstStartMatch.index;
                console.log(`[MCP] lastProcessedIndex=${firstStartMatch.index}（存在未完成的 start 标记）`);
            } else {
                // 没有任何 "start" 标签了，安全地跳到末尾
                state.lastProcessedIndex = state.contentAccumulator.length;
            }
        }

        // 缓冲区大小控制
        const MAX_BUFFER = 2 * 1024 * 1024;
        const TRIM_TO = 1 * 1024 * 1024;
        if (state.contentAccumulator.length > MAX_BUFFER) {
            state.contentAccumulator = state.contentAccumulator.slice(-TRIM_TO);
            delete state.lastProcessedIndex;
        }
    }

    // ================= [保留] SSE处理逻辑 =================
    function processBuffer(state) {
        const lines = state.sseBuffer.split('\n');
        state.sseBuffer = lines.pop() || '';

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;
            const jsonStr = trimmed.substring(6);
            if (jsonStr === '[DONE]') continue;

            try {
                const json = JSON.parse(jsonStr);
                let text = '';
                if (json.p === 'response/fragments/-1/content' && json.o === 'APPEND' && typeof json.v === 'string') {
                    text = json.v;
                } else if (json.p === 'response' && json.o === 'BATCH' && Array.isArray(json.v)) {
                    for (const op of json.v) {
                        if (op.p === 'fragments' && op.o === 'APPEND' && Array.isArray(op.v)) {
                            for (const frag of op.v) {
                                if (frag && typeof frag.content === 'string') text += frag.content;
                            }
                        }
                    }
                } else {
                    function deepExtract(obj) {
                        if (typeof obj === 'string') return obj;
                        if (Array.isArray(obj)) return obj.map(deepExtract).join('');
                        if (typeof obj === 'object' && obj !== null) {
                            const keys = ['v', 'content', 'text', 'fragments'];
                            for (const k of keys) if (obj[k]) return deepExtract(obj[k]);
                            return Object.values(obj).map(deepExtract).join('');
                        }
                        return '';
                    }
                    text = deepExtract(json);
                }

                if (text) {
                    state.contentAccumulator += text;
                    checkToolCalls(state);
                }
            } catch (e) {}
        }
    }

    // ================= [保留] 工具执行逻辑 =================
    async function executeTool(name, args) {
        const callId = Date.now() + Math.random();
        activeToolCalls.push(callId);
        if (name !== 'get_role_card') showOverlay();

        try {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('工具执行超时')), 60000));
            const result = await Promise.race([execstart(name, args), timeoutPromise]);
            let text = "执行完成";

            if (result.success) {
                if (name === 'get_role_card') {
                    text = result.result?.result?.content || result.result?.content?.[0]?.text || result.result?.content || JSON.stringify(result.result);
                    window.commandResults = `\n📊 MCP初始化成功\n---\n${text}\n---\n`;
                } else {
                    text = result.result?.content?.[0]?.text || result.result?.stdout || JSON.stringify(result.result);
                    window.commandResults += `\n📊 工具 ${name} 结果:\n${text}\n---\n`;
                }
            } else {
                window.commandResults += `\n❌ 工具 ${name} 失败: ${result.error}\n---\n`;
            }
        } catch (e) {
            window.commandResults += `\n❌ 工具 ${name} 异常: ${e.message}\n---\n`;
        } finally {
            activeToolCalls = activeToolCalls.filter(id => id !== callId);
            if (name !== 'get_role_card') hideOverlay();
        }
    }

    // ================= [保留] 拦截器逻辑 =================
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._url = url;
        return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function(body) {
        if (this._url && this._url.includes('/api/v0/chat/completion') && body) {
            try {
                if (typeof body === 'string') {
                    const data = JSON.parse(body);
                    const originalPrompt = typeof data.prompt === 'string' ? data.prompt : null;
                    if (originalPrompt != null) {
                        let modifiedPrompt = originalPrompt;
                        const rules = [{
                            original: /发送命令xxxoooxxx/g,
                            replacement: function() { return window.commandResults || ''; }
                        }];
                        rules.forEach(rule => {
                            rule.original.lastIndex = 0;
                            if (rule.original.test(originalPrompt)) {
                                modifiedPrompt = originalPrompt.replace(rule.original, rule.replacement);
                            }
                        });
                        if (modifiedPrompt !== originalPrompt) {
                            data.prompt = modifiedPrompt;
                            body = JSON.stringify(data);
                            setTimeout(() => {
                                window.commandResults = '';
                                window.shouldSendAfterStream = false;
                            }, 1000);
                        }
                    }
                }
            } catch (e) {}
        }

        if (this._url && this._url.includes('/api/v0/chat/completion')) {
            this._mcpSSEState = {
                processedIndex: 0,
                sseBuffer: '',
                contentAccumulator: '',
                lastProcessedIndex: 0
            };

            // 【修复 v0.8 - Bug1】同时处理 readyState 3 和 4
            // 原来只处理 readyState === 3，当 XHR 完成时 readyState 变为 4，
            // 最后一批数据（可能包含工具调用标记）被永久丢失！
            // 这就是为什么"最后一个工具调用总是漏掉"的原因。
            const processSSEData = () => {
                if (this.responseText && this._mcpSSEState) {
                    const state = this._mcpSSEState;
                    if (state.processedIndex < this.responseText.length) {
                        const newData = this.responseText.substring(state.processedIndex);
                        state.processedIndex = this.responseText.length;
                        state.sseBuffer += newData;
                        processBuffer(state);
                    }
                }
            };

            this.addEventListener('progress', () => {
                if ((this.readyState === 3 || this.readyState === 4) && this.responseText && this._mcpSSEState) {
                    processSSEData();
                }
            });

            // 【修复 v0.8 - Bug2】添加 load handler 刷新剩余缓冲区
            // processBuffer 用 lines.pop() 保留最后一个不完整的行在 sseBuffer 中，
            // 但如果流结束了，这个剩余行永远不会被处理。
            // 在 load 事件中强制刷新：给 sseBuffer 加个换行符让它被处理。
            this.addEventListener('load', () => {
                if (this._mcpSSEState) {
                    const state = this._mcpSSEState;
                    // 先处理可能遗漏的最后一段 responseText
                    if (this.responseText && state.processedIndex < this.responseText.length) {
                        const newData = this.responseText.substring(state.processedIndex);
                        state.sseBuffer += newData;
                        state.processedIndex = this.responseText.length;
                    }
                    // 强制刷新剩余缓冲区（加换行让最后一行被处理）
                    if (state.sseBuffer.trim()) {
                        state.sseBuffer += '\n';
                        processBuffer(state);
                    }
                    console.log('[MCP v0.8] 流结束，已刷新缓冲区。contentAccumulator长度:', state.contentAccumulator.length);
                }
            });

            this.addEventListener('loadend', () => {
                // 【修复 v0.8 - Bug3】在等待工具完成之前，再做一次最终检查
                // 确保 load handler 中新发现的 marker 也被处理
                if (this._mcpSSEState) {
                    checkToolCalls(this._mcpSSEState);
                }

                let checkCount = 0;
                const MAX_CHECKS = 240;
                const finalCheck = setInterval(() => {
                    checkCount++;
                    if (activeToolCalls.length === 0 || checkCount >= MAX_CHECKS) {
                        clearInterval(finalCheck);
                        if (window.commandResults) {
                            hideOverlay();
                            simulateTypeAndSend(window.MCP_SEND_PLACEHOLDER);
                        }
                    }
                }, 500);
            });
        }
        return originalSend.call(this, body);
    };

    // ================= [保留] MCP客户端 =================
    class UniversalMCPClient {
        constructor(serverUrl) {
            this.serverUrl = serverUrl;
            this.requestId = 1;
        }

        async call(toolName, params) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: this.serverUrl,
                    headers: { 'Content-Type': 'application/json; charset=utf-8' },
                    data: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'tools/call',
                        params: { name: toolName, arguments: params },
                        id: this.requestId++
                    }),
                    timeout: 60000,
                    onload: (res) => {
                        try {
                            const response = JSON.parse(res.responseText);
                            resolve(response.error ?
                                { success: false, error: response.error.message } :
                                { success: true, result: response.result });
                        } catch (e) {
                            resolve({ success: false, error: '响应解析失败: ' + e.message });
                        }
                    },
                    onerror: (err) => resolve({ success: false, error: err.statusText || '网络失败' }),
                    ontimeout: () => resolve({ success: false, error: '请求超时(60s)' })
                });
            });
        }
    }

    let requestLock = false;
    async function execstart(tool, params) {
        const MAX_WAIT = 60;
        let waitCount = 0;
        while (requestLock) {
            if (waitCount >= MAX_WAIT) {
                console.warn('⚠️ 请求锁等待超时，强制执行');
                break;
            }
            await new Promise(r => setTimeout(r, 500));
            waitCount++;
        }
        requestLock = true;
        try {
            const client = new UniversalMCPClient('http://localhost:8024/mcp');
            return await client.call(tool, params);
        } finally {
            requestLock = false;
        }
    }

    // ================= 初始化 =================
    createInitButton();

})();
