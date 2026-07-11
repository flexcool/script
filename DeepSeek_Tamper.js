// ==UserScript==
// @name         DeepSeek qwen-code Enhanced Auto Send (Optimized + Direct Reply)
// @namespace    http://tampermonkey.net/
// @version      0.5
// @description  SSE监控 + MCP客户端（优化start/end捕获，增加手动触发面板，支持直接回复，UI适配）
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

    // ================= [优化] 手动触发面板逻辑 (DeepSeek UI 风格) =================
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

        // 输入框聚焦效果
        const input = document.getElementById('mcp-manual-input');
        input.addEventListener('focus', () => input.style.borderColor = '#60a5fa');
        input.addEventListener('blur', () => input.style.borderColor = '#374151');

        // 绑定提交事件
        document.getElementById('mcp-manual-submit').addEventListener('click', async () => {
            const msgDiv = document.getElementById('mcp-manual-msg');
            const submitBtn = document.getElementById('mcp-manual-submit');
            const rawText = input.value.trim();

            if (!rawText) {
                msgDiv.style.color = '#f87171';
                msgDiv.textContent = '输入内容不能为空';
                return;
            }

            const match = rawText.match(/start:\s*({[\s\S]*?})\s*end/);
            if (!match) {
                msgDiv.style.color = '#f87171';
                msgDiv.textContent = '格式错误，请确保包含 start:{...}end';
                return;
            }

            try {
                const toolData = JSON.parse(match[1]);
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

    // ================= [修改] 初始化按钮逻辑（拆分为两个按钮） =================
    function createInitButton() {
        const container = document.createElement('div');
        container.id = 'mcp-btn-container';
        container.style.cssText = `position: fixed; top: 20px; right: 20px; z-index: 10002; display: flex; gap: 8px; font-family: system-ui, -apple-system, sans-serif;`;

        // 1. 初始化按钮
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

        // 2. 手动面板切换按钮
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
            // 激活状态变色
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

    // ================= [核心优化] 工具调用检测逻辑 =================
    let activeToolCalls = [];

    function findToolCallMarkers(text) {
        const markers = [];
        const startRegex = /start:\s*({[\s\S]*?})\s*end(?!\w)/g;
        let match;
        while ((match = startRegex.exec(text)) !== null) {
            const fullMatch = match[0];
            const jsonContent = match[1];
            const startIndex = match.index;
            const endIndex = startIndex + fullMatch.length;
            try {
                const parsedArgs = JSON.parse(jsonContent);
                markers.push({ start: startIndex, end: endIndex, jsonContent: parsedArgs });
            } catch (e) {
                console.warn("发现无效JSON格式的start/end块:", jsonContent);
            }
        }
        return markers;
    }

    function checkToolCalls(state) {
        const currentContent = state.contentAccumulator;
        const potentialMarkers = findToolCallMarkers(currentContent);
        const newMarkers = potentialMarkers.filter(marker => marker.start >= (state.lastProcessedIndex || 0));

        if (newMarkers.length > 0) console.log(`[MCP] 检测到 ${newMarkers.length} 个新工具调用`);

        for (const marker of newMarkers) {
            const toolData = marker.jsonContent;
            if (!toolData || !toolData.name) continue;

            console.log("[MCP] 自动执行工具:", toolData.name, toolData.arguments);
            executeTool(toolData.name, toolData.arguments || {});

            const replacement = `\n[PROCESSED_MCP_CALL:${toolData.name}]\n`;
            state.contentAccumulator = state.contentAccumulator.substring(0, marker.start) + replacement + state.contentAccumulator.substring(marker.end);
            state.lastProcessedIndex = marker.start + replacement.length;
        }

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

            this.addEventListener('progress', () => {
                if (this.readyState === 3 && this.responseText && this._mcpSSEState) {
                    const state = this._mcpSSEState;
                    const newData = this.responseText.substring(state.processedIndex);
                    state.processedIndex = this.responseText.length;
                    state.sseBuffer += newData;
                    processBuffer(state);
                }
            });

            this.addEventListener('loadend', () => {
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
