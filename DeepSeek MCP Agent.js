// ==UserScript==
// @name         DeepSeek MCP Agent
// @namespace    http://tampermonkey.net/
// @version      2.0.0
// @description  DeepSeek MCP 自动捕获 start:{...}end 并调用本地 MCP
// @author       AI工作助理
// @match        https://chat.deepseek.com/*
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @run-at       document-start
// ==/UserScript==
(function () {
    'use strict';
    // ============================================================
    // 配置
    // ============================================================
    const MCP_URL = 'http://localhost:8024/mcp';
    // MCP 最大等待时间
    const MCP_WAIT_TIMEOUT = 120000;
    // Assistant 内容停止变化多久后，认为本轮回复结束
    const RESPONSE_STABLE_TIME = 1200;
    // MutationObserver 防抖
    const OBSERVER_DEBOUNCE = 100;
    // ============================================================
    // 全局状态
    // ============================================================
    let assistantObserver = null;
    let observerTimer = null;
    let overlay = null;
    let panel = null;
    /*
     * 每一个 Assistant 消息都有独立状态。
     *
     * WeakMap<Element, {
     *     text: string,
     *     tools: Set,
     *     results: Array,
     *     resultSent: boolean,
     *     stableTimer: number|null,
     *     processing: boolean
     * }>
     */
    const messageStates = new WeakMap();
    // 所有正在执行的 MCP Promise
    const runningTasks = new Set();
    // ============================================================
    // 日志
    // ============================================================
    function log() {
        try {
            console.log.apply(
                console,
                ['[DeepSeek-MCP]'].concat(
                    Array.prototype.slice.call(arguments)
                )
            );
        } catch (e) {
        }
    }
    function warn() {
        try {
            console.warn.apply(
                console,
                ['[DeepSeek-MCP]'].concat(
                    Array.prototype.slice.call(arguments)
                )
            );
        } catch (e) {
        }
    }
    function error() {
        try {
            console.error.apply(
                console,
                ['[DeepSeek-MCP]'].concat(
                    Array.prototype.slice.call(arguments)
                )
            );
        } catch (e) {
        }
    }
    // ============================================================
    // 通用工具
    // ============================================================
    function sleep(ms) {
        return new Promise(function (resolve) {
            setTimeout(resolve, ms);
        });
    }
    // ============================================================
    // Overlay
    // ============================================================
    function createOverlay() {
        if (overlay) {
            return;
        }
        overlay = document.createElement('div');
        overlay.id = 'deepseek-mcp-overlay';
        overlay.style.cssText = [
            'position:fixed',
            'right:20px',
            'bottom:20px',
            'z-index:999999',
            'background:rgba(20,20,20,.92)',
            'color:#fff',
            'padding:10px 14px',
            'border-radius:8px',
            'font-size:13px',
            'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
            'box-shadow:0 4px 16px rgba(0,0,0,.3)',
            'display:none',
            'max-width:420px',
            'word-break:break-all'
        ].join(';');
        document.body.appendChild(overlay);
    }
    function showOverlay(text, timeout) {
        if (!overlay) {
            createOverlay();
        }
        overlay.textContent = text;
        overlay.style.display = 'block';
        if (showOverlay.timer) {
            clearTimeout(showOverlay.timer);
        }
        if (timeout) {
            showOverlay.timer = setTimeout(
                function () {
                    if (overlay) {
                        overlay.style.display = 'none';
                    }
                },
                timeout
            );
        }
    }
    // ============================================================
    // 按钮样式
    // ============================================================
    function buttonStyle() {
        return [
            'border:none',
            'border-radius:6px',
            'padding:7px 12px',
            'background:#4b5563',
            'color:#fff',
            'cursor:pointer',
            'font-size:12px',
            'box-shadow:0 2px 6px rgba(0,0,0,.2)'
        ].join(';');
    }
    // ============================================================
    // 创建顶部按钮
    // ============================================================
    function createButtons() {
        if (
            document.getElementById(
                'deepseek-mcp-buttons'
            )
        ) {
            return;
        }
        const container =
            document.createElement('div');
        container.id =
            'deepseek-mcp-buttons';
        container.style.cssText = [
            'position:fixed',
            'top:80px',
            'right:20px',
            'z-index:999998',
            'display:flex',
            'flex-direction:column',
            'gap:8px'
        ].join(';');
        // --------------------------------------------------------
        // MCP 初始化
        // --------------------------------------------------------
        const initButton =
            document.createElement('button');
        initButton.textContent =
            'MCP 初始化';
        initButton.style.cssText =
            buttonStyle();
        initButton.addEventListener(
            'click',
            function () {
                initializeMCP();
            }
        );
        // --------------------------------------------------------
        // MCP 手动
        // --------------------------------------------------------
        const toolButton =
            document.createElement('button');
        toolButton.textContent =
            'MCP 手动';
        toolButton.style.cssText =
            buttonStyle();
        toolButton.addEventListener(
            'click',
            function () {
                toggleToolPanel();
            }
        );
        container.appendChild(
            initButton
        );
        container.appendChild(
            toolButton
        );
        document.body.appendChild(
            container
        );
    }
    // ============================================================
    // MCP 手动面板
    //
    // 直接输入：
    //
    // start:{"name":"get_cwd","arguments":{}}end
    //
    // ============================================================
    function createToolPanel() {
        if (panel) {
            return;
        }
        panel =
            document.createElement('div');
        panel.id =
            'deepseek-mcp-panel';
        panel.style.cssText = [
            'position:fixed',
            'top:80px',
            'right:130px',
            'z-index:999997',
            'width:430px',
            'background:#fff',
            'border:1px solid #ddd',
            'border-radius:8px',
            'padding:12px',
            'box-shadow:0 6px 20px rgba(0,0,0,.25)',
            'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif',
            'display:none'
        ].join(';');
        // --------------------------------------------------------
        // 标题
        // --------------------------------------------------------
        const title =
            document.createElement('div');
        title.textContent =
            'MCP 手动调用';
        title.style.cssText = [
            'font-size:14px',
            'font-weight:bold',
            'margin-bottom:8px'
        ].join(';');
        // --------------------------------------------------------
        // 输入框
        // --------------------------------------------------------
        const commandInput =
            document.createElement('textarea');
        commandInput.id =
            'deepseek-mcp-command';
        commandInput.placeholder =
            '输入完整 MCP 指令，例如：\n' +
            'start:{"name":"get_cwd","arguments":{}}end';
        commandInput.value =
            'start:{"name":"get_cwd","arguments":{}}end';
        commandInput.style.cssText = [
            'box-sizing:border-box',
            'width:100%',
            'height:120px',
            'border:1px solid #ddd',
            'border-radius:5px',
            'padding:8px',
            'margin-top:6px',
            'font-size:12px',
            'font-family:monospace',
            'resize:vertical',
            'outline:none'
        ].join(';');
        // --------------------------------------------------------
        // 执行 MCP
        // --------------------------------------------------------
        const executeButton =
            document.createElement('button');
        executeButton.textContent =
            '执行 MCP';
        executeButton.style.cssText = [
            buttonStyle(),
            'background:#2563eb',
            'margin-top:8px'
        ].join(';');
        executeButton.addEventListener(
            'click',
            function () {
                const command =
                    commandInput.value.trim();
                if (!command) {
                    alert('请输入 MCP 指令');
                    return;
                }
                executeManualCommand(
                    command
                );
            }
        );
        // --------------------------------------------------------
        // 发送原始指令到 DeepSeek
        // --------------------------------------------------------
        const sendButton =
            document.createElement('button');
        sendButton.textContent =
            '发送到 DeepSeek';
        sendButton.style.cssText = [
            buttonStyle(),
            'background:#059669',
            'margin-top:8px',
            'margin-left:6px'
        ].join(';');
        sendButton.addEventListener(
            'click',
            async function () {
                const command =
                    commandInput.value.trim();
                if (!command) {
                    alert('请输入 MCP 指令');
                    return;
                }
                await safeSend(command);
            }
        );
        // --------------------------------------------------------
        // 清空
        // --------------------------------------------------------
        const clearButton =
            document.createElement('button');
        clearButton.textContent =
            '清空';
        clearButton.style.cssText = [
            buttonStyle(),
            'background:#6b7280',
            'margin-top:8px',
            'margin-left:6px'
        ].join(';');
        clearButton.addEventListener(
            'click',
            function () {
                commandInput.value = '';
            }
        );
        const buttonContainer =
            document.createElement('div');
        buttonContainer.style.cssText = [
            'display:flex',
            'align-items:center'
        ].join(';');
        buttonContainer.appendChild(
            executeButton
        );
        buttonContainer.appendChild(
            sendButton
        );
        buttonContainer.appendChild(
            clearButton
        );
        panel.appendChild(title);
        panel.appendChild(
            commandInput
        );
        panel.appendChild(
            buttonContainer
        );
        document.body.appendChild(
            panel
        );
    }
    function toggleToolPanel() {
        createToolPanel();
        if (
            panel.style.display === 'none'
        ) {
            panel.style.display =
                'block';
        } else {
            panel.style.display =
                'none';
        }
    }
    // ============================================================
    // DeepSeek 输入框
    // ============================================================
    function findEditor() {
        // --------------------------------------------------------
        // textarea
        // --------------------------------------------------------
        const textareas =
            document.querySelectorAll(
                'textarea'
            );
        for (
            let i = 0;
            i < textareas.length;
            i++
        ) {
            const el =
                textareas[i];
            if (
                el.offsetParent !== null &&
                !el.disabled &&
                !el.readOnly
            ) {
                return el;
            }
        }
        // --------------------------------------------------------
        // contenteditable
        // --------------------------------------------------------
        const editors =
            document.querySelectorAll(
                '[contenteditable="true"]'
            );
        for (
            let j = 0;
            j < editors.length;
            j++
        ) {
            const el2 =
                editors[j];
            if (
                el2.offsetParent !== null &&
                !el2.getAttribute(
                    'aria-hidden'
                )
            ) {
                return el2;
            }
        }
        return null;
    }
    // ============================================================
    // DeepSeek 发送按钮
    // ============================================================
    function findSendButton() {
        // --------------------------------------------------------
        // submit
        // --------------------------------------------------------
        const submits =
            document.querySelectorAll(
                'button[type="submit"]'
            );
        for (
            let i = 0;
            i < submits.length;
            i++
        ) {
            const button =
                submits[i];
            if (
                button.offsetParent !== null &&
                !button.disabled
            ) {
                return button;
            }
        }
        // --------------------------------------------------------
        // aria-label / title / 文本
        // --------------------------------------------------------
        const buttons =
            document.querySelectorAll(
                'button'
            );
        for (
            let j = 0;
            j < buttons.length;
            j++
        ) {
            const button2 =
                buttons[j];
            if (
                button2.offsetParent === null ||
                button2.disabled
            ) {
                continue;
            }
            const aria = (
                button2.getAttribute(
                    'aria-label'
                ) || ''
            ).toLowerCase();
            const title = (
                button2.getAttribute(
                    'title'
                ) || ''
            ).toLowerCase();
            const text = (
                button2.innerText ||
                ''
            ).trim();
            if (
                aria.indexOf('send') >= 0 ||
                title.indexOf('send') >= 0 ||
                text === '发送'
            ) {
                return button2;
            }
        }
        return null;
    }
    // ============================================================
    // 发送消息到 DeepSeek
    // ============================================================
    async function safeSend(text) {
        if (!text) {
            return false;
        }
        log(
            '📤 准备发送:',
            text
        );
        const editor =
            findEditor();
        if (!editor) {
            error(
                '找不到 DeepSeek 输入框'
            );
            showOverlay(
                '❌ 找不到 DeepSeek 输入框',
                3000
            );
            return false;
        }
        try {
            // ----------------------------------------------------
            // textarea
            // ----------------------------------------------------
            if (
                editor.tagName ===
                'TEXTAREA'
            ) {
                const setter =
                    Object.getOwnPropertyDescriptor(
                        HTMLTextAreaElement.prototype,
                        'value'
                    );
                if (
                    setter &&
                    setter.set
                ) {
                    setter.set.call(
                        editor,
                        text
                    );
                } else {
                    editor.value =
                        text;
                }
                editor.dispatchEvent(
                    new Event(
                        'input',
                        {
                            bubbles: true
                        }
                    )
                );
                editor.dispatchEvent(
                    new Event(
                        'change',
                        {
                            bubbles: true
                        }
                    )
                );
            }
            // ----------------------------------------------------
            // contenteditable
            // ----------------------------------------------------
            else {
                editor.focus();
                editor.textContent =
                    text;
                try {
                    editor.dispatchEvent(
                        new InputEvent(
                            'input',
                            {
                                bubbles: true,
                                inputType:
                                    'insertText',
                                data: text
                            }
                        )
                    );
                } catch (e) {
                    editor.dispatchEvent(
                        new Event(
                            'input',
                            {
                                bubbles: true
                            }
                        )
                    );
                }
            }
            // 给 DeepSeek 前端一点时间同步状态
            await sleep(150);
            // ----------------------------------------------------
            // 找发送按钮
            // ----------------------------------------------------
            const sendButton =
                findSendButton();
            if (sendButton) {
                log(
                    '🖱 点击发送按钮'
                );
                sendButton.click();
                return true;
            }
            // ----------------------------------------------------
            // 最后尝试 Enter
            // ----------------------------------------------------
            log(
                '⚠️ 未找到发送按钮，尝试 Enter'
            );
            editor.focus();
            editor.dispatchEvent(
                new KeyboardEvent(
                    'keydown',
                    {
                        key: 'Enter',
                        code: 'Enter',
                        keyCode: 13,
                        which: 13,
                        bubbles: true
                    }
                )
            );
            return true;
        } catch (e) {
            error(
                '发送失败:',
                e
            );
            showOverlay(
                '❌ 发送失败: ' +
                e.message,
                4000
            );
            return false;
        }
    }
    // ============================================================
    // MCP Client
    // ============================================================
    class MCPClient {
        constructor(url) {
            this.url = url;
            this.requestId = 0;
        }
        call(name, args) {
            const self = this;
            return new Promise(
                function (resolve, reject) {
                    const id =
                        ++self.requestId;
                    const body = {
                        jsonrpc: '2.0',
                        id: id,
                        method: 'tools/call',
                        params: {
                            name: name,
                            arguments:
                                args || {}
                        }
                    };
                    log(
                        '🔧 MCP CALL:',
                        name,
                        args
                    );
                    GM_xmlhttpRequest({
                        method: 'POST',
                        url: self.url,
                        headers: {
                            'Content-Type':
                                'application/json'
                        },
                        data:
                            JSON.stringify(
                                body
                            ),
                        timeout:
                            MCP_WAIT_TIMEOUT,
                        onload:
                            function (response) {
                                if (
                                    response.status <
                                        200 ||
                                    response.status >=
                                        300
                                ) {
                                    reject(
                                        new Error(
                                            'HTTP ' +
                                            response.status
                                        )
                                    );
                                    return;
                                }
                                let data;
                                try {
                                    data =
                                        JSON.parse(
                                            response.responseText
                                        );
                                } catch (e) {
                                    reject(
                                        new Error(
                                            'MCP 返回 JSON 解析失败: ' +
                                            response.responseText
                                        )
                                    );
                                    return;
                                }
                                if (
                                    data.error
                                ) {
                                    reject(
                                        new Error(
                                            data.error.message ||
                                            JSON.stringify(
                                                data.error
                                            )
                                        )
                                    );
                                    return;
                                }
                                resolve(
                                    data.result
                                );
                            },
                        onerror:
                            function () {
                                reject(
                                    new Error(
                                        'MCP 网络连接失败'
                                    )
                                );
                            },
                        ontimeout:
                            function () {
                                reject(
                                    new Error(
                                        'MCP 请求超时'
                                    )
                                );
                            }
                    });
                }
            );
        }
    }
    const client =
        new MCPClient(
            MCP_URL
        );
    // ============================================================
    // MCP 工具执行
    // ============================================================
    function execTool(
        name,
        args
    ) {
        const task =
            client.call(
                name,
                args
            )
            .then(
                function (result) {
                    log(
                        '✅ MCP RESULT:',
                        name,
                        result
                    );
                    return {
                        name: name,
                        arguments:
                            args || {},
                        result: result,
                        success: true
                    };
                }
            )
            .catch(
                function (e) {
                    error(
                        '❌ MCP ERROR:',
                        name,
                        e
                    );
                    return {
                        name: name,
                        arguments:
                            args || {},
                        error:
                            e.message ||
                            String(e),
                        success: false
                    };
                }
            );
        runningTasks.add(
            task
        );
        task.then(
            function () {
                runningTasks.delete(
                    task
                );
            },
            function () {
                runningTasks.delete(
                    task
                );
            }
        );
        return task;
    }
    // ============================================================
    // 等待所有 MCP 任务
    // ============================================================
    async function waitAllTasks() {
        while (
            runningTasks.size > 0
        ) {
            const tasks =
                Array.from(
                    runningTasks
                );
            await Promise.all(
                tasks
            );
            await sleep(20);
        }
    }
    // ============================================================
    // 从 start: 后面解析 JSON
    //
    // 支持：
    //
    // start:{"name":"get_cwd","arguments":{}}end
    //
    // 以及嵌套 JSON：
    //
    // start:{
    //     "name":"xxx",
    //     "arguments":{
    //         "data":{
    //             "a":1
    //         }
    //     }
    // }end
    //
    // ============================================================
    function parseJson(
        text,
        startIndex
    ) {
        const firstBrace =
            text.indexOf(
                '{',
                startIndex
            );
        if (
            firstBrace < 0
        ) {
            return null;
        }
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (
            let i = firstBrace;
            i < text.length;
            i++
        ) {
            const c =
                text[i];
            // ----------------------------------------------------
            // JSON 字符串内部
            // ----------------------------------------------------
            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (
                    c === '\\'
                ) {
                    escaped = true;
                } else if (
                    c === '"'
                ) {
                    inString = false;
                }
                continue;
            }
            // ----------------------------------------------------
            // JSON 字符串开始
            // ----------------------------------------------------
            if (
                c === '"'
            ) {
                inString = true;
                continue;
            }
            // ----------------------------------------------------
            // JSON 对象
            // ----------------------------------------------------
            if (
                c === '{'
            ) {
                depth++;
            } else if (
                c === '}'
            ) {
                depth--;
                if (
                    depth === 0
                ) {
                    const jsonText =
                        text.substring(
                            firstBrace,
                            i + 1
                        );
                    try {
                        return {
                            value:
                                JSON.parse(
                                    jsonText
                                ),
                            endIndex:
                                i + 1
                        };
                    } catch (e) {
                        warn(
                            'JSON 解析失败:',
                            jsonText
                        );
                        return null;
                    }
                }
            }
        }
        return null;
    }
    // ============================================================
    // 解析：
    //
    // start:{...}end
    //
    // ============================================================
    async function processBuffer(
        element,
        text,
        state
    ) {
        let searchIndex = 0;
        while (true) {
            const startIndex =
                text.indexOf(
                    'start:',
                    searchIndex
                );
            if (
                startIndex < 0
            ) {
                break;
            }
            const parsed =
                parseJson(
                    text,
                    startIndex + 6
                );
            // JSON 尚未完整
            //
            // DeepSeek 流式输出时可能出现：
            //
            // start:{"name":"get_cwd"
            //
            // 下一次 Mutation 后才完整。
            if (!parsed) {
                break;
            }
            const endIndex =
                text.indexOf(
                    'end',
                    parsed.endIndex
                );
            // end 尚未出现
            if (
                endIndex < 0
            ) {
                break;
            }
            searchIndex =
                endIndex + 3;
            const command =
                parsed.value;
            if (
                !command ||
                typeof command !== 'object'
            ) {
                continue;
            }
            if (
                !command.name
            ) {
                warn(
                    'MCP 指令没有 name:',
                    command
                );
                continue;
            }
            const toolName =
                String(
                    command.name
                );
            const args =
                command.arguments &&
                typeof command.arguments ===
                    'object'
                    ? command.arguments
                    : {};
            // ----------------------------------------------------
            // 当前 Assistant 消息内去重
            // ----------------------------------------------------
            const toolKey =
                JSON.stringify({
                    name: toolName,
                    arguments: args
                });
            if (
                state.tools.has(
                    toolKey
                )
            ) {
                log(
                    '⏭ 跳过重复 MCP:',
                    toolName
                );
                continue;
            }
            state.tools.add(
                toolKey
            );
            log(
                '🎯 捕获 MCP:',
                toolName,
                args
            );
            showOverlay(
                '🔧 MCP: ' +
                toolName,
                2500
            );
            // ----------------------------------------------------
            // 执行 MCP
            // ----------------------------------------------------
            const task =
                execTool(
                    toolName,
                    args
                );
            state.results.push(
                task
            );
        }
    }
    // ============================================================
    // DeepSeek Assistant DOM
    //
    // 根据实际 DOM：
    //
    // <div class="ds-markdown ds-assistant-message-main-content">
    //
    // ============================================================
    function getAssistantMessages() {
        return document.querySelectorAll(
            '.ds-markdown.ds-assistant-message-main-content'
        );
    }
    function getLastAssistantMessage() {
        const messages =
            getAssistantMessages();
        if (
            !messages.length
        ) {
            return null;
        }
        return messages[
            messages.length - 1
        ];
    }
    // ============================================================
    // 获取某一个 Assistant 消息的状态
    // ============================================================
    function getMessageState(
        element
    ) {
        let state =
            messageStates.get(
                element
            );
        if (!state) {
            state = {
                text: '',
                tools:
                    new Set(),
                results: [],
                resultSent:
                    false,
                stableTimer:
                    null,
                processing:
                    false
            };
            messageStates.set(
                element,
                state
            );
        }
        return state;
    }
    // ============================================================
    // 检查 Assistant 消息
    // ============================================================
    function checkAssistantMessage(
        element
    ) {
        if (!element) {
            return;
        }
        const text =
            element.innerText ||
            element.textContent ||
            '';
        if (!text) {
            return;
        }
        const state =
            getMessageState(
                element
            );
        // --------------------------------------------------------
        // 内容没有变化
        // --------------------------------------------------------
        if (
            state.text === text
        ) {
            return;
        }
        state.text =
            text;
        log(
            '📝 Assistant 更新:',
            text
        );
        // --------------------------------------------------------
        // 立即尝试解析 MCP
        //
        // 不等待回复结束。
        //
        // 这样 DeepSeek 一生成完整：
        //
        // start:{...}end
        //
        // 就开始调用 MCP。
        // --------------------------------------------------------
        processBuffer(
            element,
            text,
            state
        );
        // --------------------------------------------------------
        // 回复稳定计时器
        // --------------------------------------------------------
        if (
            state.stableTimer
        ) {
            clearTimeout(
                state.stableTimer
            );
        }
        state.stableTimer =
            setTimeout(
                function () {
                    handleAssistantStable(
                        element,
                        state
                    );
                },
                RESPONSE_STABLE_TIME
            );
    }
    // ============================================================
    // Assistant 回复稳定
    // ============================================================
    async function handleAssistantStable(
        element,
        state
    ) {
        // 已经发送过
        if (
            state.resultSent
        ) {
            return;
        }
        // 正在处理
        if (
            state.processing
        ) {
            return;
        }
        // 没有 MCP
        if (
            !state.results.length
        ) {
            return;
        }
        state.processing =
            true;
        log(
            '⏳ Assistant 回复稳定，等待 MCP:',
            state.results.length
        );
        showOverlay(
            '⏳ 等待 MCP 执行...',
            3000
        );
        try {
            // ----------------------------------------------------
            // 等待当前 Assistant 的 MCP
            // ----------------------------------------------------
            const results =
                await Promise.all(
                    state.results
                );
            // ----------------------------------------------------
            // 防止其他 MCP 任务还没结束
            // ----------------------------------------------------
            await waitAllTasks();
            if (
                state.resultSent
            ) {
                return;
            }
            // ----------------------------------------------------
            // 构造返回消息
            // ----------------------------------------------------
            const resultText =
                buildResultMessage(
                    results
                );
            log(
                '📤 MCP 结果:',
                resultText
            );
            // ----------------------------------------------------
            // 发回 DeepSeek
            // ----------------------------------------------------
            const sent =
                await safeSend(
                    resultText
                );
            if (sent) {
                state.resultSent =
                    true;
                showOverlay(
                    '✅ MCP 结果已发送',
                    2500
                );
                log(
                    '✅ MCP 结果发送完成'
                );
            } else {
                warn(
                    '❌ MCP 结果发送失败'
                );
            }
        } catch (e) {
            error(
                '处理 MCP 结果失败:',
                e
            );
        } finally {
            state.processing =
                false;
        }
    }
    // ============================================================
    // 构造 MCP 返回消息
    // ============================================================
    function buildResultMessage(
        results
    ) {
        const lines = [];
        lines.push(
            'MCP 工具执行结果：'
        );
        lines.push('');
        results.forEach(
            function (item, index) {
                lines.push(
                    '【' +
                    (index + 1) +
                    '】' +
                    item.name
                );
                if (
                    item.success
                ) {
                    let result;
                    try {
                        if (
                            typeof item.result ===
                            'string'
                        ) {
                            result =
                                item.result;
                        } else {
                            result =
                                JSON.stringify(
                                    item.result,
                                    null,
                                    2
                                );
                        }
                    } catch (e) {
                        result =
                            String(
                                item.result
                            );
                    }
                    lines.push(
                        result
                    );
                } else {
                    lines.push(
                        '执行失败: ' +
                        item.error
                    );
                }
                lines.push('');
            }
        );
        return lines.join('\n');
    }
    // ============================================================
    // MutationObserver 防抖
    // ============================================================
    function scheduleObserve() {
        if (
            observerTimer
        ) {
            clearTimeout(
                observerTimer
            );
        }
        observerTimer =
            setTimeout(
                function () {
                    observerTimer =
                        null;
                    scanAssistantMessages();
                },
                OBSERVER_DEBOUNCE
            );
    }
    // ============================================================
    // 扫描所有 Assistant
    // ============================================================
    function scanAssistantMessages() {
        const messages =
            getAssistantMessages();
        if (
            !messages.length
        ) {
            return;
        }
        // --------------------------------------------------------
        // 不只扫描最后一条
        //
        // 防止 DeepSeek DOM 更新时旧消息也发生变化。
        // WeakMap 会自动保证每个消息独立。
        // --------------------------------------------------------
        for (
            let i = 0;
            i < messages.length;
            i++
        ) {
            checkAssistantMessage(
                messages[i]
            );
        }
    }
    // ============================================================
    // 启动 DOM Observer
    // ============================================================
    function observeAssistantMessages() {
        if (
            assistantObserver
        ) {
            assistantObserver.disconnect();
        }
        assistantObserver =
            new MutationObserver(
                function () {
                    scheduleObserve();
                }
            );
        assistantObserver.observe(
            document.body,
            {
                childList: true,
                subtree: true,
                characterData: true
            }
        );
        log(
            '🚀 DeepSeek DOM MCP Observer Running'
        );
        // 页面已经存在的消息
        scanAssistantMessages();
    }
    // ============================================================
    // MCP 初始化
    // ============================================================
    async function initializeMCP() {
        showOverlay(
            '🔄 MCP 初始化...',
            3000
        );
        try {
            const result =
                await client.call(
                    'get_role_card',
                    {}
                );
            log(
                '📋 角色卡:',
                result
            );
            let text;
            if (
                typeof result ===
                'string'
            ) {
                text =
                    result;
            } else {
                text =
                    JSON.stringify(
                        result,
                        null,
                        2
                    );
            }
            const message =
                'AI工作助理初始化完成。\n\n' +
                text;
            await safeSend(
                message
            );
            showOverlay(
                '✅ MCP 初始化完成',
                3000
            );
        } catch (e) {
            error(
                'MCP 初始化失败:',
                e
            );
            showOverlay(
                '❌ MCP 初始化失败: ' +
                e.message,
                5000
            );
        }
    }
    // ============================================================
    // 手动执行完整 MCP 指令
    //
    // 例如：
    //
    // start:{"name":"get_cwd","arguments":{}}end
    //
    // ============================================================
    async function executeManualCommand(
        command
    ) {
        log(
            '📥 手动 MCP:',
            command
        );
        const fakeElement =
            document.createElement(
                'div'
            );
        const state = {
            text: command,
            tools:
                new Set(),
            results: [],
            resultSent:
                false,
            stableTimer:
                null,
            processing:
                false
        };
        try {
            // ----------------------------------------------------
            // 直接使用自动模式同一套解析器
            // ----------------------------------------------------
            await processBuffer(
                fakeElement,
                command,
                state
            );
            if (
                !state.results.length
            ) {
                alert(
                    '没有找到有效的 MCP 指令。\n\n' +
                    '正确格式：\n' +
                    'start:{"name":"get_cwd","arguments":{}}end'
                );
                return;
            }
            showOverlay(
                '🔧 手动 MCP 执行中...',
                3000
            );
            // ----------------------------------------------------
            // 等待 MCP
            // ----------------------------------------------------
            const results =
                await Promise.all(
                    state.results
                );
            // ----------------------------------------------------
            // 构造结果
            // ----------------------------------------------------
            const resultText =
                buildResultMessage(
                    results
                );
            log(
                '📤 手动 MCP 结果:',
                resultText
            );
            // ----------------------------------------------------
            // 自动发送结果到 DeepSeek
            // ----------------------------------------------------
            const sent =
                await safeSend(
                    resultText
                );
            if (sent) {
                showOverlay(
                    '✅ 手动 MCP 执行完成',
                    2500
                );
            } else {
                showOverlay(
                    '❌ MCP 结果发送失败',
                    4000
                );
            }
        } catch (e) {
            error(
                '手动 MCP 执行失败:',
                e
            );
            showOverlay(
                '❌ MCP 执行失败: ' +
                e.message,
                4000
            );
        }
    }
    // ============================================================
    // 页面启动
    // ============================================================
    function start() {
        log(
            '🚀 DeepSeek MCP Agent 启动'
        );
        if (!document.body) {
            setTimeout(
                start,
                100
            );
            return;
        }
        createOverlay();
        createButtons();
        createToolPanel();
        observeAssistantMessages();
        log(
            '✅ DeepSeek MCP Agent Ready'
        );
    }
    // ============================================================
    // document-start 兼容
    // ============================================================
    if (
        document.readyState ===
        'loading'
    ) {
        document.addEventListener(
            'DOMContentLoaded',
            start
        );
    } else {
        start();
    }
})();
