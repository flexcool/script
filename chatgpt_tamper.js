// ==UserScript==
// @name         ChatGPT MCP Agent v6.8 (Auto Capture + Manual Init)
// @namespace    http://tampermonkey.net/
// @version      6.8
// @description  Auto capture start/end without init + Manual trigger panel
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    // ================= 状态 =================
    let buffer = '';
    let lastHash = 0;

    let pendingTools = new Map();
    let runningTasks = [];
    let results = [];

    let activeTurn = 0;
    let stableTimer = null;
    let isProcessing = false;

    // ================= UI 元素引用 =================
    let overlay;
    let manualPanel;
    let isPanelVisible = false;

    // ================= UI: 遮罩层 =================
    function createOverlay() {
        overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed;top:0;left:0;width:100%;height:100%;
            background:rgba(0,0,0,0.6);
            display:none;justify-content:center;align-items:center;
            z-index:9999;color:#fff;font-size:18px;
        `;
        overlay.innerHTML = `<div style="background:#111;padding:20px;border-radius:10px">
            🔄 MCP v6.8 执行中...
        </div>`;
        document.body.appendChild(overlay);
    }

    function showOverlay() { overlay.style.display = 'flex'; }
    function hideOverlay() { overlay.style.display = 'none'; }

    // ================= UI: 手动面板 (ChatGPT 风格) =================
    function createManualPanel() {
        if (document.getElementById('mcp-manual-panel')) return;

        manualPanel = document.createElement('div');
        manualPanel.id = 'mcp-manual-panel';
        manualPanel.style.cssText = `
            position: fixed; top: 60px; right: 130px; z-index: 10001;
            background: #ffffff; color: #374151; border: 1px solid #e5e7eb;
            border-radius: 12px; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1);
            padding: 16px; width: 360px; font-family: system-ui, -apple-system, sans-serif;
            display: none;
        `;

        manualPanel.innerHTML = `
            <div style="font-size: 14px; font-weight: 600; margin-bottom: 10px; color: #111827; display: flex; align-items: center; gap: 6px;">
                <span>⚡</span> 手动触发 MCP 工具
            </div>
            <textarea id="mcp-manual-input" placeholder='例如: start:{"name":"get_weather","arguments":{"city":"Beijing"}}end'
                style="width: 100%; height: 100px; background: #f9fafb; border: 1px solid #d1d5db; border-radius: 8px; padding: 10px; font-size: 13px; color: #111827; resize: vertical; box-sizing: border-box; outline: none; transition: border-color 0.2s; font-family: monospace;"></textarea>
            <button id="mcp-manual-submit" style="
                margin-top: 10px; width: 100%; padding: 10px; background-color: #10a37f; color: #ffffff;
                border: none; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;
            ">执行并发送</button>
            <div id="mcp-manual-msg" style="margin-top: 8px; font-size: 12px; color: #6b7280; word-break: break-all; max-height: 100px; overflow-y: auto; line-height: 1.4;"></div>
        `;
        document.body.appendChild(manualPanel);

        // 输入框聚焦效果
        const input = document.getElementById('mcp-manual-input');
        input.addEventListener('focus', () => input.style.borderColor = '#10a37f');
        input.addEventListener('blur', () => input.style.borderColor = '#d1d5db');

        // 提交事件
        document.getElementById('mcp-manual-submit').addEventListener('click', async (e) => {
            e.stopPropagation();
            const msgDiv = document.getElementById('mcp-manual-msg');
            const submitBtn = document.getElementById('mcp-manual-submit');
            const rawText = input.value.trim();

            if (!rawText) {
                msgDiv.style.color = '#ef4444';
                msgDiv.textContent = '输入内容不能为空';
                return;
            }

            const startIdx = rawText.indexOf('start:');
            const endIdx = rawText.lastIndexOf('end');

            if (startIdx === -1 || endIdx === -1) {
                msgDiv.style.color = '#ef4444';
                msgDiv.textContent = '格式错误，请确保包含 start:...end';
                return;
            }

            try {
                const jsonStr = rawText.substring(startIdx + 6, endIdx).trim();
                const toolData = JSON.parse(jsonStr);

                msgDiv.style.color = '#3b82f6';
                msgDiv.textContent = '⏳ 正在执行...';
                submitBtn.disabled = true;
                submitBtn.style.opacity = '0.7';

                const result = await execTool(toolData.name, toolData.arguments || {});

                let replyText = "";
                if (result?.error) {
                    replyText = `❌ 工具 ${toolData.name} 执行失败: ${result.error}`;
                    msgDiv.style.color = '#ef4444';
                    msgDiv.textContent = replyText;
                } else {
                    replyText = result?.content?.[0]?.text || JSON.stringify(result);
                    msgDiv.style.color = '#10a37f';
                    msgDiv.textContent = '✅ 执行成功，正在发送...';
                }

                if (replyText) {
                    await safeSend(replyText);
                    input.value = '';
                    toggleManualPanel();
                }

            } catch (e) {
                msgDiv.style.color = '#ef4444';
                msgDiv.textContent = '❌ 解析错误: ' + e.message;
            } finally {
                submitBtn.disabled = false;
                submitBtn.style.opacity = '1';
            }
        });
    }

    function toggleManualPanel() {
        isPanelVisible = !isPanelVisible;
        if (manualPanel) {
            manualPanel.style.display = isPanelVisible ? 'block' : 'none';
        }
    }

    // ================= UI: 顶部按钮组 =================
    function createButtons() {
        const container = document.createElement('div');
        container.id = 'mcp-btn-container';
        container.style.cssText = `position: fixed; top: 20px; right: 20px; z-index: 10002; display: flex; gap: 10px; font-family: system-ui, -apple-system, sans-serif;`;

        // 1. 初始化按钮 (仅触发 get_role_card)
        const initBtn = document.createElement('button');
        initBtn.innerText = '🔄 初始化 MCP';
        initBtn.style.cssText = `
            background-color: #ffffff; color: #374151; padding: 10px 16px;
            border: 1px solid #d1d5db; border-radius: 8px; cursor: pointer;
            font-size: 14px; font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            transition: all 0.2s;
        `;
        initBtn.onmouseenter = () => { initBtn.style.backgroundColor = '#f3f4f6'; initBtn.style.borderColor = '#9ca3af'; }
        initBtn.onmouseleave = () => { initBtn.style.backgroundColor = '#ffffff'; initBtn.style.borderColor = '#d1d5db'; }
        initBtn.onclick = async () => {
            initBtn.innerText = '⏳ 获取中...';
            initBtn.style.color = '#3b82f6';
            initBtn.style.borderColor = '#3b82f6';

            showOverlay();
            const res = await client.call('get_role_card', {});
            const text = res?.result?.content?.[0]?.text || JSON.stringify(res);
            await safeSend(`📊 MCP INIT\n---\n${text}`);
            hideOverlay();

            initBtn.innerText = '✅ 已初始化';
            initBtn.style.color = '#10a37f';
            initBtn.style.borderColor = '#10a37f';
            setTimeout(() => {
                initBtn.innerText = '🔄 初始化 MCP';
                initBtn.style.color = '#374151';
                initBtn.style.borderColor = '#d1d5db';
            }, 2000);
        };

        // 2. 手动面板按钮
        const toggleBtn = document.createElement('button');
        toggleBtn.innerText = '⚡ 手动工具';
        toggleBtn.style.cssText = `
            background-color: #10a37f; color: #ffffff; padding: 10px 16px;
            border: 1px solid #10a37f; border-radius: 8px; cursor: pointer;
            font-size: 14px; font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,0.05);
            transition: all 0.2s;
        `;
        toggleBtn.onmouseenter = () => { toggleBtn.style.backgroundColor = '#0d8c6d'; }
        toggleBtn.onmouseleave = () => { toggleBtn.style.backgroundColor = '#10a37f'; }
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            createManualPanel();
            toggleManualPanel();
        };

        container.appendChild(initBtn);
        container.appendChild(toggleBtn);
        document.body.appendChild(container);
    }

    // ================= 点击页面空白处关闭面板 =================
    document.addEventListener('click', (e) => {
        if (isPanelVisible && manualPanel && !manualPanel.contains(e.target) && !e.target.closest('#mcp-btn-container')) {
            toggleManualPanel();
        }
    });

    // ================= 输入框 =================
    function getEditor() {
        return document.querySelector('#prompt-textarea')

            || document.querySelector('textarea')
            || document.querySelector('[contenteditable="true"]');
    }

    async function safeSend(text) {
        const el = getEditor();
        if (!el) return;

        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, text);

        await new Promise(r => setTimeout(r, 120));

        const btn = document.querySelector('button[data-testid="send-button"]');
        if (btn) btn.click();
        else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }

    // ================= MCP Client =================
    class MCPClient {
        constructor(url) {
            this.url = url;
            this.id = 1;
        }

        call(tool, args) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest({
                    method: 'POST',
                    url: this.url,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'tools/call',
                        params: { name: tool, arguments: args },
                        id: this.id++
                    }),
                    timeout: 60000,
                    onload: (res) => {
                        try {
                            resolve(JSON.parse(res.responseText));
                        } catch {
                            resolve({ error: 'parse error' });
                        }
                    },
                    onerror: () => resolve({ error: 'network error' }),
                    ontimeout: () => resolve({ error: 'timeout' })
                });
            });
        }
    }

    const client = new MCPClient('http://localhost:8024/mcp');

    async function execTool(name, args) {
        showOverlay();
        try {
            const res = await client.call(name, args);
            return res?.result || res;
        } finally {
            hideOverlay();
        }
    }

    // ================= 工具函数 =================
    function hash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) {
            h = (h << 5) - h + str.charCodeAt(i);
            h |= 0;
        }
        return h;
    }

    function parseJson(content, start) {
        let i = start;
        let depth = 0;
        let inStr = false;
        let quote = null;

        for (; i < content.length; i++) {
            const c = content[i];
            if (inStr) {
                if (c === '\\') { i++; continue; }
                if (c === quote) inStr = false;
                continue;
            }
            if (c === '"' || c === "'" || c === '`') {
                inStr = true;
                quote = c;
                continue;
            }
            if (c === '{') depth++;
            if (c === '}') depth--;
            if (depth === 0) {
                const jsonStr = content.slice(start, i + 1);
                try {
                    return { ok: true, obj: JSON.parse(jsonStr), next: i + 1 };
                } catch { return { ok: false }; }
            }
        }
        return { ok: false };
    }

    function processBuffer(text) {
        let i = 0;
        while (i < text.length) {
            if (text.slice(i).startsWith('start:')) {
                let j = i + 6;
                while (/\s/.test(text[j])) j++;
                if (text[j] !== '{') { i++; continue; }

                const parsed = parseJson(text, j);
                if (!parsed.ok) return;

                let end = parsed.next;
                while (/\s/.test(text[end])) end++;

                if (text.slice(end, end + 3) === 'end') {
                    const tool = parsed.obj;
                    if (!tool?.name) { i = end + 3; continue; }

                    const key = JSON.stringify(tool);
                    if (!pendingTools.has(key)) {
                        pendingTools.set(key, true);
                        const task = execTool(tool.name, tool.arguments || {})
                            .then(res => {
                                let t = '';
                                if (res?.error) t = `❌ ${tool.name}: ${res.error}`;
                                else t = res?.content?.[0]?.text || res?.content || JSON.stringify(res);
                                results.push({ name: tool.name, text: t });
                            });
                        runningTasks.push(task);
                    }
                    i = end + 3;
                    continue;
                }
            }
            i++;
        }
    }

    function isResponding() {
        return !!document.querySelector('button[data-testid="stop-button"]');
    }

    function flush() {
        const timer = setInterval(async () => {
            if (isResponding()) return;
            clearInterval(timer);
            if (!runningTasks.length) return;
            await Promise.all(runningTasks);
            let out = '';
            for (const r of results) {
                out += `\n📊 ${r.name}:\n${r.text}\n---\n`;
            }
            runningTasks = [];
            results = [];
            pendingTools.clear();
            buffer = '';
            await safeSend(out);
        }, 800);
    }

    function onUpdate(text) {
        if (!text) return;
        buffer = text;
        const h = hash(text);
        if (h === lastHash) return;
        lastHash = h;
        clearTimeout(stableTimer);
        activeTurn++;
        stableTimer = setTimeout(() => {
            processBuffer(buffer);
            flush();
        }, 600);
    }

    // ================= 🔥 核心修改：自动启动监听 =================
    function observe() {
        const obs = new MutationObserver(() => {
            const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
            if (!msgs.length) return;
            const text = msgs[msgs.length - 1].innerText;
            onUpdate(text);
        });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        console.log('🚀 MCP v6.8 Auto-Capture Running');
    }

    // ================= 初始化入口 =================
    function main() {
        createOverlay();
        createButtons();
        observe(); // 脚本加载后立即开启监听，无需等待手动初始化
    }
    main();

})();
