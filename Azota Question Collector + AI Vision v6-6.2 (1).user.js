// ==UserScript==
// @name         Azota Question Collector + AI Vision v6
// @namespace    http://tampermonkey.net/
// @version      6.2
// @description  Collect Azota questions, analyze text and images with AI, retry failures with Ctrl+Alt+H
// @match        https://azota.vn/*
// @grant        GM_xmlhttpRequest
// @connect      api.orimise.com
// @connect      liveazotastoragept112025.azota.vn
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        ANTHROPIC_APIS: [
      {
                name: 'Orimise',
                url: 'https://api.orimise.com/v1/messages',
                key: 'sk-',
                model: 'claude-opus-5'
            },
            {
                name: 'Anthropic API 2',
                url: 'https://api.orimise.com/v1/messages',
                key: 'sk-',
                model: 'claude-opus-5'
            },
            {
                name: 'Anthropic API 3',
                url: 'https://api.orimise.com/v1/messages',
                key: 'sk-',
                model: 'claude-opus-5'
            }
        ],

        ENABLE_AI: true,
        ENABLE_HIGHLIGHT: true,

        SCAN_DELAY: 600,
        REQUEST_TIMEOUT: 60000,
        MIN_REQUEST_INTERVAL: 3000,
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 1500
    };

    const SYSTEM_CONTEXT = `
Bạn là trợ lý học tập chuyên phân tích câu hỏi trắc nghiệm
môn Chủ nghĩa xã hội khoa học.

Kiến thức:
- Chủ nghĩa Mác - Lênin
- Sự ra đời của chủ nghĩa xã hội khoa học
- Sứ mệnh lịch sử của giai cấp công nhân
- Cách mạng xã hội chủ nghĩa
- Thời kỳ quá độ lên chủ nghĩa xã hội
- Dân chủ và nhà nước xã hội chủ nghĩa
- Cơ cấu xã hội - giai cấp
- Liên minh giai cấp, tầng lớp
- Vấn đề dân tộc và tôn giáo
- Gia đình trong thời kỳ quá độ

Phân tích nội dung câu hỏi và các lựa chọn được cung cấp dưới dạng văn bản
hoặc hình ảnh.

Ưu tiên độ chính xác, đặc biệt với các từ:
"đúng nhất", "chủ yếu", "cơ bản", "quan trọng nhất".

Nếu không đọc rõ câu hỏi hoặc không đủ thông tin,
không được đoán.

Chỉ trả về một trong các giá trị:
A
B
C
D
UNKNOWN
`.trim();

    const PREDICTION_SYSTEM_CONTEXT = SYSTEM_CONTEXT
        .replace(
            'Nếu không đọc rõ câu hỏi hoặc không đủ thông tin,\nkhông được đoán.',
            'Chế độ dự đoán đang bật: nếu chưa chắc, hãy suy luận và chọn đáp án A, B, C hoặc D có khả năng đúng nhất. Tuyệt đối không trả UNKNOWN.'
        )
        .replace('A\nB\nC\nD\nUNKNOWN', 'A\nB\nC\nD');

    const questions = new Map();
    const queue = [];
    const queuedIds = new Set();

    let processing = false;
    let scanTimer = null;
    let predictionMode = false;
    let predictionRunId = 0;

    function normalize(text) {
        return String(text ?? '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getOptionSignature(options) {
        return JSON.stringify(
            options
                .map(option => normalize(option.text))
                .sort()
        );
    }

    function getImageSignature(images) {
        return JSON.stringify(images);
    }

    function getRecordSignature(data) {
        return JSON.stringify({
            questionText: normalize(data.questionText),
            images: data.questionImages,
            options: getOptionSignature(data.options)
        });
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function extractQuestion(element) {
        const id = element.id.replace('question_all_', '');

        const label = element.querySelector(
            '.question-standalone-label'
        );

        const number = Number(
            label?.textContent.match(/\d+/)?.[0]
        ) || null;

        const content = element.querySelector(
            '.question-standalone-content-side'
        );

        const images = Array.from(
            content?.querySelectorAll('img') ?? []
        )
            .map(img => img.currentSrc || img.src)
            .filter(Boolean);

        const questionText = normalize(content?.innerText ?? '');

        const answerElements = element.querySelectorAll(
            '.list-answer .item-answer'
        );

        const options = Array.from(answerElements)
            .map((answer, index) => {
                const label = normalize(
                    answer.querySelector('button')?.textContent
                );

                const answerContent = answer.querySelector(
                    '.answer-content'
                );

                return {
                    index: index + 1,
                    label: label || String(index + 1),
                    text: normalize(answerContent?.innerText),
                    images: Array.from(
                        answerContent?.querySelectorAll('img') ?? []
                    ).map(img => img.currentSrc || img.src)
                };
            })
            .filter(option => option.text || option.images.length);

        return {
            id,
            number,
            questionText,
            questionImages: images,
            options
        };
    }

    function collectQuestions() {
        const elements = document.querySelectorAll(
            '.azt-question[id^="question_all_"]'
        );

        for (const element of elements) {
            const data = extractQuestion(element);

            if (!data.options.length) continue;
            if (!data.questionImages.length && !data.questionText) {
                continue;
            }

            const old = questions.get(data.id);

            if (!old) {
                const record = {
                    ...data,
                    signature: getRecordSignature(data),
                    aiAnswer: null,
                    retryCount: 0,
                    retryModeActive: false,
                    status: 'pending',
                    timestamp: new Date().toISOString()
                };

                questions.set(data.id, record);

                console.log(
                    `[Azota] Collected question ${data.number ?? '?'}`,
                    record
                );

                enqueue(data.id);
                continue;
            }

            const newSignature = getRecordSignature(data);

            if (old.signature !== newSignature) {
                const oldOptionSignature =
                    getOptionSignature(old.options);

                const newOptionSignature =
                    getOptionSignature(data.options);

                const contentChanged =
                    oldOptionSignature !== newOptionSignature ||
                    getImageSignature(old.questionImages) !==
                    getImageSignature(data.questionImages) ||
                    old.questionText !== data.questionText;

                Object.assign(old, data);
                old.signature = newSignature;

                if (contentChanged) {
                    old.aiAnswer = null;
                    old.retryCount = 0;
                    old.retryModeActive = false;
                    old.status = 'pending';
                    clearQuestionHighlight(data.id);
                }
            }

            if (old.aiAnswer) {
                highlightAnswer(old);
            } else if (old.status === 'pending') {
                enqueue(data.id);
            }
        }
    }

    function downloadImage(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: 'blob',
                timeout: CONFIG.REQUEST_TIMEOUT,

                onload(response) {
                    if (
                        response.status < 200 ||
                        response.status >= 300
                    ) {
                        reject(new Error(
                            `Image HTTP ${response.status}`
                        ));
                        return;
                    }

                    const blob = response.response;
                    const reader = new FileReader();

                    reader.onload = () => {
                        const result = String(reader.result);
                        const base64 = result.split(',')[1];

                        resolve({
                            type: blob.type || 'image/png',
                            data: base64
                        });
                    };

                    reader.onerror = () => {
                        reject(new Error('Cannot read image'));
                    };

                    reader.readAsDataURL(blob);
                },

                onerror: () => reject(
                    new Error('Image network error')
                ),

                ontimeout: () => reject(
                    new Error('Image timeout')
                )
            });
        });
    }

    async function buildAIContent(data, usePredictionMode) {
        const optionsText = data.options
            .map(option => `${option.label}. ${option.text}`)
            .join('\n');

        const content = [{
            type: 'text',
            text: `
Câu số: ${data.number ?? '?'}

Nội dung câu hỏi dạng văn bản:
${data.questionText || '(Xem hình ảnh đính kèm)'}

Các lựa chọn:
${optionsText || '(Không có lựa chọn dạng văn bản)'}

Phân tích nội dung câu hỏi và các lựa chọn dạng văn bản hoặc hình ảnh.
${usePredictionMode
    ? 'Chế độ dự đoán bật: phải chọn phương án A, B, C hoặc D có khả năng đúng nhất; không được trả UNKNOWN.'
    : 'Nếu không xác định được đáp án thì trả UNKNOWN.'}
Chỉ trả về một lựa chọn đúng định dạng.
`.trim()
        }];

        for (const url of data.questionImages) {
            const image = await downloadImage(url);

            if (
                ![
                    'image/jpeg',
                    'image/png',
                    'image/gif',
                    'image/webp'
                ].includes(image.type)
            ) {
                throw new Error(
                    `Unsupported image type: ${image.type}`
                );
            }

            content.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: image.type,
                    data: image.data
                }
            });
        }

        for (const option of data.options) {
            for (const url of option.images ?? []) {
                const image = await downloadImage(url);

                content.push({
                    type: 'text',
                    text: `Hình ảnh của phương án ${option.label}:`
                });

                content.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: image.type,
                        data: image.data
                    }
                });
            }
        }

        return content;
    }

    let lastRequestAt = 0;

    function waitForRequestInterval() {
        const elapsed = Date.now() - lastRequestAt;
        const delay = Math.max(
            0,
            CONFIG.MIN_REQUEST_INTERVAL - elapsed
        );

        return sleep(delay).then(() => {
            lastRequestAt = Date.now();
        });
    }

    function makeApiError(message, status = 0) {
        const error = new Error(message);
        error.status = status;
        return error;
    }

    function sendAIRequest(api, content, usePredictionMode, runId) {
        return new Promise((resolve, reject) => {
            const requestUsesPredictionMode = usePredictionMode;
            const requestPredictionRunId = runId;
            const body = {
                model: api.model,
                max_tokens: 2048,
                system: requestUsesPredictionMode
                    ? PREDICTION_SYSTEM_CONTEXT
                    : SYSTEM_CONTEXT,
                messages: [{
                    role: 'user',
                    content
                }]
            };

            GM_xmlhttpRequest({
                method: 'POST',
                url: api.url,
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': api.key,
                    'anthropic-version': '2023-06-01'
                },
                data: JSON.stringify(body),
                timeout: CONFIG.REQUEST_TIMEOUT,

                onload(response) {
                    const responseText = String(response.responseText ?? '');

                    if (response.status < 200 || response.status >= 300) {
                        reject(makeApiError(
                            `Anthropic API ${response.status}: ` +
                            responseText.slice(0, 1000),
                            response.status
                        ));
                        return;
                    }

                    try {
                        const result = JSON.parse(responseText);
                        const text = (result.content ?? [])
                            .filter(block =>
                                block.type === 'text' &&
                                typeof block.text === 'string'
                            )
                            .map(block => block.text)
                            .join('\n')
                            .trim();

                        if (!text) {
                            throw new Error(
                                `API không trả về văn bản đáp án: ${responseText.slice(0, 1000)}`
                            );
                        }

                        const normalized = text
                            .replace(/```(?:text)?/gi, '')
                            .replace(/```/g, '')
                            .trim();
                        const match = normalized.match(
                            requestUsesPredictionMode
                                ? /^(A|B|C|D)[.!]?$/i
                                : /^(A|B|C|D|UNKNOWN)[.!]?$/i
                        );

                        if (!match) {
                            throw new Error(
                                `Phản hồi không đúng định dạng: ${text}`
                            );
                        }

                        resolve({
                            answer: match[1].toUpperCase(),
                            predictionMode: requestUsesPredictionMode,
                            predictionRunId: requestPredictionRunId
                        });
                    } catch (error) {
                        reject(makeApiError(
                            `Không đọc được phản hồi từ ${api.name}: ${error.message}`,
                            400
                        ));
                    }
                },

                onerror: () => reject(makeApiError('Lỗi kết nối API')),
                ontimeout: () => reject(makeApiError('API timeout', 408))
            });
        });
    }

    async function tryProviderList(apis, content, usePredictionMode, runId) {
        for (const api of apis) {
            if (!api.key || api.key.startsWith('PASTE_')) {
                console.warn(
                    `[Azota AI] Bỏ qua ${api.name}: chưa điền API key`
                );
                continue;
            }

            await waitForRequestInterval();

            try {
                const result = await sendAIRequest(
                    api,
                    content,
                    usePredictionMode,
                    runId
                );

                console.info(
                    `[Azota AI] Dùng API thành công: ${api.name}`
                );

                return {
                    answer: result.answer,
                    predictionMode: result.predictionMode,
                    predictionRunId: result.predictionRunId,
                    provider: api
                };
            } catch (error) {
                console.error(
                    `[Azota AI] ${api.name} lỗi; chuyển sang API kế tiếp:`,
                    error
                );
            }
        }

        return null;
    }

    async function requestWithApiRotation(content, usePredictionMode, runId) {
        const result = await tryProviderList(
            CONFIG.ANTHROPIC_APIS,
            content,
            usePredictionMode,
            runId
        );

        if (result) return result;

        throw new Error(
            'Tất cả API Anthropic đều lỗi hoặc chưa được cấu hình.'
        );
    }

    async function askAI(data) {
        const usePredictionMode = predictionMode;
        const runId = predictionRunId;
        const content = await buildAIContent(data, usePredictionMode);
        return requestWithApiRotation(content, usePredictionMode, runId);
    }

    function enqueue(id) {
        if (!CONFIG.ENABLE_AI) return;
        if (queuedIds.has(id)) return;

        const data = questions.get(id);

        if (
            !data ||
            data.aiAnswer ||
            data.status === 'processing'
        ) {
            return;
        }

        queuedIds.add(id);
        queue.push(id);

        processQueue();
    }

    async function processQueue() {
        if (processing) return;

        processing = true;

        try {
            while (queue.length) {
                const id = queue.shift();
                queuedIds.delete(id);

                const data = questions.get(id);
                if (!data || (data.aiAnswer && !predictionMode)) continue;

                console.info(
                    `[Azota AI] ⏳ Câu ${data.number ?? '?'} ` +
                    `(ID: ${id}) đang xử lý`
                );

                const signature = data.signature;
                const requestRunId = predictionRunId;
                data.status = 'processing';

                try {
                    const result = await askAI(data);
                    const current = questions.get(id);

                    if (!current) continue;

                    if (current.signature !== signature) {
                        current.status = 'pending';
                        enqueue(id);

                        console.warn(
                            `[Azota AI] Câu ${data.number ?? '?'} ` +
                            `(ID: ${id}) đã thay đổi trong lúc xử lý; ` +
                            'đưa vào hàng đợi lại'
                        );
                        continue;
                    }

                    // Ctrl+Alt+J may have been pressed while a normal answer
                    // request was still running. Ignore that stale result;
                    // the prediction run has already queued every question.
                    if (
                        predictionMode &&
                        result.predictionRunId !== predictionRunId
                    ) {
                        current.aiAnswer = null;
                        current.status = 'pending';
                        clearQuestionHighlight(id);
                        console.info(
                            `[Azota AI] Câu ${current.number ?? '?'} ` +
                            `(ID: ${id}) được chuyển sang lượt dự đoán.`
                        );
                        continue;
                    }

                    if (result.answer === 'UNKNOWN') {
                        if (predictionMode && !result.predictionMode) {
                            current.status = 'pending';
                            enqueue(id);
                            console.info(
                                `[Azota AI] Câu ${current.number ?? '?'} ` +
                                `(ID: ${id}) sẽ được xử lý lại bằng chế độ dự đoán.`
                            );
                            continue;
                        }

                        current.status = 'unknown';
                        current.aiAnswer = null;

                        console.warn(
                            `[Azota AI] ⚠️ Câu ${current.number ?? '?'} ` +
                            `(ID: ${id}) không xác định được đáp án`
                        );
                    } else {
                        const option = current.options.find(
                            item => item.label.toUpperCase() === result.answer
                        );

                        if (!option) {
                            throw new Error(
                                `Không tìm thấy phương án ${result.answer} ` +
                                `trong câu ${current.number ?? '?'}`
                            );
                        }

                        current.aiAnswer = {
                            label: option.label,
                            text: option.text,
                            images: option.images,
                            model: result.provider.model,
                            provider: result.provider.name
                        };

                        current.retryCount = 0;
                        current.retryModeActive = false;
                        current.status = 'completed';
                        highlightAnswer(current);

                        console.info(
                            `[Azota AI] ✅ Câu ${current.number ?? '?'} ` +
                            `(ID: ${id}) hoàn thành — Đáp án: ${result.answer} ` +
                            `— API: ${result.provider.name}`
                        );
                    }
                } catch (error) {
                    const current = questions.get(id);

                    if (current && predictionMode && requestRunId !== predictionRunId) {
                        current.status = 'pending';
                        console.info(
                            `[Azota AI] Câu ${current.number ?? '?'} ` +
                            `(ID: ${id}) được giữ cho lượt dự đoán mới.`
                        );
                        continue;
                    }

                    if (current && current.signature === signature) {
                        const retriesUsed = Number(current.retryCount) || 0;
                        if (retriesUsed < CONFIG.MAX_RETRIES) {
                            current.retryCount = retriesUsed + 1;
                            current.status = 'retrying';
                            const delay = CONFIG.RETRY_DELAY_MS * current.retryCount;
                            const retrySource = current.retryModeActive
                                ? 'theo phím tắt'
                                : 'tự động';

                            console.warn(
                                `[Azota AI] 🔁 Câu ${current.number ?? '?'} ` +
                                `(ID: ${id}) lỗi; thử lại ${retrySource} ` +
                                `lần ${current.retryCount}/${CONFIG.MAX_RETRIES} ` +
                                `sau ${delay}ms`
                            );

                            await sleep(delay);

                            const latest = questions.get(id);
                            if (latest && latest.signature === signature) {
                                latest.status = 'pending';
                                enqueue(id);
                            }
                        } else {
                            current.retryModeActive = false;
                            current.status = 'error';
                            console.error(
                                `[Azota AI] ⛔ Câu ${current.number ?? '?'} ` +
                                `(ID: ${id}) vẫn lỗi sau ` +
                                `${CONFIG.MAX_RETRIES} lần thử lại.`
                            );
                        }
                    }

                    console.error(
                        `[Azota AI] ❌ Câu ${data.number ?? '?'} ` +
                        `(ID: ${id}) thất bại:`,
                        error
                    );
                }
            }
        } finally {
            processing = false;
        }
    }

    function injectStyles() {
        document.getElementById('azota-ai-style')?.remove();

        const style = document.createElement('style');
        style.id = 'azota-ai-style';

        style.textContent = `
            .azota-ai-suggested {
                position: relative !important;
            }

            .azota-ai-suggested::after {
                content: "" !important;
                position: absolute !important;
                width: 1.5px !important;
                height: 1.5px !important;
                background: #888888 !important;
                border-radius: 50% !important;
                left: -4px !important;
                top: 50% !important;
                transform: translateY(-50%) !important;
                pointer-events: none !important;
                z-index: 1000 !important;
            }
        `;

        document.head.appendChild(style);
    }

    function clearQuestionHighlight(id) {
        const element = document.getElementById(
            `question_all_${id}`
        );

        if (!element) return;

        element.querySelectorAll('.azota-ai-suggested')
            .forEach(node => {
                node.classList.remove('azota-ai-suggested');
            });
    }

    function highlightAnswer(data) {
        if (
            !CONFIG.ENABLE_HIGHLIGHT ||
            !data.aiAnswer
        ) {
            return false;
        }

        const element = document.getElementById(
            `question_all_${data.id}`
        );

        if (!element) return false;

        clearQuestionHighlight(data.id);

        const answers = Array.from(
            element.querySelectorAll(
                '.list-answer .item-answer'
            )
        );

        const target = answers.find(answer => {
            const text = normalize(
                answer.querySelector('.answer-content')?.innerText
            );

            const images = Array.from(
                answer.querySelectorAll('.answer-content img')
            ).map(img => img.currentSrc || img.src);

            return text === data.aiAnswer.text &&
                JSON.stringify(images) ===
                JSON.stringify(data.aiAnswer.images ?? []);
        });

        if (!target) return false;

        target.classList.add('azota-ai-suggested');
        return true;
    }

    function scheduleScan() {
        clearTimeout(scanTimer);

        scanTimer = setTimeout(
            collectQuestions,
            CONFIG.SCAN_DELAY
        );
    }

    const observer = new MutationObserver(mutations => {
        const relevant = mutations.some(mutation => {
            if (mutation.type === 'childList') {
                return mutation.addedNodes.length > 0 ||
                    mutation.removedNodes.length > 0;
            }

            return mutation.type === 'characterData';
        });

        if (relevant) scheduleScan();
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
    });

    window.azotaQuiz = {
        getAll() {
            return [...questions.values()];
        },

        count() {
            return questions.size;
        },

        print() {
            for (const data of questions.values()) {
                console.log(
                    `CÂU ${data.number ?? '?'} - ID ${data.id}`
                );
                console.log('Images:', data.questionImages);
                console.table(data.options);
                console.log('AI answer:', data.aiAnswer);
                console.log('Status:', data.status);
            }
        },

        json() {
            return JSON.stringify(this.getAll(), null, 2);
        },

        exportJSON() {
            const blob = new Blob(
                [this.json()],
                { type: 'application/json' }
            );

            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');

            link.href = url;
            link.download = 'azota-questions.json';
            link.click();

            URL.revokeObjectURL(url);
        },

        scan() {
            collectQuestions();
        },

        retry(id) {
            const data = questions.get(String(id));
            if (!data) return false;

            data.aiAnswer = null;
            data.retryCount = 0;
            data.retryModeActive = true;
            data.status = 'pending';

            enqueue(String(id));
            return true;
        },

        retryErrors() {
            let queued = 0;
            for (const data of questions.values()) {
                if (data.status === 'error') {
                    data.retryCount = 0;
                    data.retryModeActive = true;
                    data.status = 'pending';
                    enqueue(data.id);
                    queued++;
                }
            }
            console.info(`[Azota AI] Bắt đầu thử lại ${queued} câu đang lỗi; tối đa ${CONFIG.MAX_RETRIES} lượt mỗi câu.`);
            return queued;
        },

        clear() {
            questions.clear();
            queue.length = 0;
            queuedIds.clear();

            document.querySelectorAll('.azota-ai-suggested')
                .forEach(element => {
                    element.classList.remove(
                        'azota-ai-suggested'
                    );
                });

            console.log('[Azota] Cleared');
        },

        config() {
            return {
                anthropicApiCount: CONFIG.ANTHROPIC_APIS.length,
                enableAI: CONFIG.ENABLE_AI,
                enableHighlight: CONFIG.ENABLE_HIGHLIGHT,
                persistentCache: false,
                maxRetriesPerQuestion: CONFIG.MAX_RETRIES,
                retryDelayMs: CONFIG.RETRY_DELAY_MS,
                predictionMode
            };
        }
    };

    injectStyles();
    setTimeout(collectQuestions, 1000);

    document.addEventListener('keydown', event => {
        if (
            event.ctrlKey &&
            event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === 'h'
        ) {
            event.preventDefault();
            window.azotaQuiz.retryErrors();
        } else if (
            event.ctrlKey &&
            event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === 'j'
        ) {
            event.preventDefault();
            predictionMode = !predictionMode;

            console.info(
                `[Azota AI] Chế độ dự đoán ${predictionMode ? 'BẬT' : 'TẮT'}.`
            );

            if (predictionMode) {
                predictionRunId++;

                // Start a fresh, ordered pass over every scanned question,
                // including completed answers and questions that failed before.
                queue.length = 0;
                queuedIds.clear();

                const orderedQuestions = Array.from(questions.values())
                    .sort((a, b) => {
                        const aNumber = Number(a.number);
                        const bNumber = Number(b.number);
                        if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
                            return aNumber - bNumber;
                        }
                        return String(a.id).localeCompare(String(b.id), undefined, {
                            numeric: true
                        });
                    });

                for (const data of orderedQuestions) {
                    data.aiAnswer = null;
                    data.retryCount = 0;
                    data.retryModeActive = true;
                    data.status = 'pending';
                    clearQuestionHighlight(data.id);
                    queuedIds.add(data.id);
                    queue.push(data.id);
                }
                console.info(
                    `[Azota AI] Bắt đầu lượt dự đoán tuần tự từ câu đầu đến câu cuối: ` +
                    `${orderedQuestions.length} câu (tối đa ${CONFIG.MAX_RETRIES} lần thử lại mỗi câu).`
                );
                processQueue();
            }
        }
    });

    console.log('[Azota AI] Started');
    console.log('[Azota AI] Anthropic APIs:', CONFIG.ANTHROPIC_APIS.length);
    console.log('[Azota AI] Persistent cache: disabled');
})();