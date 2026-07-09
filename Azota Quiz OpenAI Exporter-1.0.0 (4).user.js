// ==UserScript==
// @name         Azota Quiz OpenAI Exporter
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  Đọc câu hỏi từ azota.vn, tra cứu qua OpenAI-compatible API hoặc dữ liệu JSON offline, rồi xuất kết quả ra file JSON
// @author       You
// @match        https://azota.vn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      llmgate.app
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @connect      vertex-key.com
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    // =============================
    // CONFIG  ver1
    // =============================
    const CONFIG = {
        //Lưu ý: Nếu thêm API thì phải thiết lập thêm @connect tương ứng
        API_PROVIDERS: [

            
            {
                name: '9router_local',
                baseUrl: 'http://localhost:20128/v1',
                apiKey: 'sk-e22595f7fdb80f1e-qxsl8v-74efa177',
                models: ['cx/gpt-5.4']
            },
            // Ví dụ:
            // ,
            // {
            //     name: 'OpenRouter',
            //     baseUrl: 'https://openrouter.ai/api/v1',
            //     apiKey: 'sk-or-v1-xxxx',
            //     models: ['google/gemini-2.0-flash-001', 'openai/gpt-4o-mini']
            // },
            // {
            //     name: 'Provider 2',
            //     baseUrl: 'https://another-openai-compatible-endpoint.com/v1',
            //     apiKey: 'sk-xxxx',
            //     models: ['qwen-plus', 'qwen-turbo']
            // }
        ],
        MATCH_THRESHOLD: 0.8,
        MAX_RETRIES: 3,
        RETRY_DELAY_MIN_MS: 5000,
        RETRY_DELAY_MAX_MS: 10000,
        STORAGE_KEY: 'azota_offline_question_bank_v1',
        EXPORT_FILE_PREFIX: 'azota_quiz_results',
        REQUEST_TIMEOUT_MS: 45000
    };

    // =============================
    // STATE
    // =============================
    let isProcessing = false;
    let lastResolvedResults = [];
    let hasAutoProcessed = false;
    let autoProcessObserver = null;
    let preferredApiCandidateKey = '';

    // =============================
    // UI HELPERS
    // =============================
    function showNotification(message, type = 'info', duration = 3500) {
        const levelMap = {
            info: 'INFO',
            success: 'SUCCESS',
            warning: 'WARNING',
            error: 'ERROR'
        };

        console.log(`[${levelMap[type] || 'INFO'}] ${message}`);
    }

    // =============================
    // GENERAL HELPERS
    // =============================
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function randomBetween(min, max) {
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function timestampForFilename() {
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        return [
            now.getFullYear(),
            pad(now.getMonth() + 1),
            pad(now.getDate())
        ].join('-') + '_' + [
            pad(now.getHours()),
            pad(now.getMinutes()),
            pad(now.getSeconds())
        ].join('-');
    }

    function safeJsonParse(text, fallback = null) {
        try {
            return JSON.parse(text);
        } catch (error) {
            return fallback;
        }
    }

    function normalizeText(text) {
        return String(text || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/<[^>]*>/g, ' ')
            .replace(/[^\p{L}\p{N}\s]/gu, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function tokenize(text) {
        return normalizeText(text)
            .split(' ')
            .map(item => item.trim())
            .filter(Boolean);
    }

    function getTokenSimilarity(a, b) {
        const tokensA = new Set(tokenize(a));
        const tokensB = new Set(tokenize(b));

        if (!tokensA.size || !tokensB.size) {
            return 0;
        }

        let intersection = 0;
        tokensA.forEach(token => {
            if (tokensB.has(token)) {
                intersection += 1;
            }
        });

        return (2 * intersection) / (tokensA.size + tokensB.size);
    }

    function getBigramSimilarity(a, b) {
        const textA = normalizeText(a).replace(/\s+/g, ' ');
        const textB = normalizeText(b).replace(/\s+/g, ' ');

        if (textA.length < 2 || textB.length < 2) {
            return textA === textB ? 1 : 0;
        }

        const bigramsA = new Map();
        const bigramsB = new Map();

        for (let i = 0; i < textA.length - 1; i++) {
            const gram = textA.slice(i, i + 2);
            bigramsA.set(gram, (bigramsA.get(gram) || 0) + 1);
        }

        for (let i = 0; i < textB.length - 1; i++) {
            const gram = textB.slice(i, i + 2);
            bigramsB.set(gram, (bigramsB.get(gram) || 0) + 1);
        }

        let intersection = 0;
        let countA = 0;
        let countB = 0;

        bigramsA.forEach(value => { countA += value; });
        bigramsB.forEach(value => { countB += value; });

        bigramsA.forEach((value, gram) => {
            if (bigramsB.has(gram)) {
                intersection += Math.min(value, bigramsB.get(gram));
            }
        });

        if (!countA || !countB) {
            return 0;
        }

        return (2 * intersection) / (countA + countB);
    }

    function getSimilarityScore(a, b) {
        const tokenScore = getTokenSimilarity(a, b);
        const bigramScore = getBigramSimilarity(a, b);
        return Number(((tokenScore * 0.6) + (bigramScore * 0.4)).toFixed(4));
    }

    function normalizeAnswerLabel(label) {
        const raw = String(label || '').trim().toUpperCase();
        const match = raw.match(/[A-Z]/);
        return match ? match[0] : raw;
    }

    function normalizeAnswers(answers) {
        if (!Array.isArray(answers)) {
            return [];
        }

        return answers
            .map((answer, index) => {
                if (typeof answer === 'string') {
                    return {
                        label: String.fromCharCode(65 + index),
                        text: answer.trim(),
                        images: []
                    };
                }

                if (answer && typeof answer === 'object') {
                    return {
                        label: normalizeAnswerLabel(answer.label || String.fromCharCode(65 + index)),
                        text: String(answer.text || answer.content || '').trim(),
                        images: Array.isArray(answer.images) ? answer.images.filter(Boolean) : []
                    };
                }

                return null;
            })
            .filter(item => item && (item.text || (Array.isArray(item.images) && item.images.length)));
    }

    function extractImageSourcesFromHtml(html) {
        return Array.from(String(html || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi))
            .map(match => String(match[1] || '').trim())
            .filter(Boolean);
    }

    function getImageSources(root) {
        if (!root) {
            return [];
        }

        const domSources = typeof root.querySelectorAll === 'function'
            ? Array.from(root.querySelectorAll('img'))
                .map(img => String(
                    img.getAttribute('src') ||
                    img.getAttribute('data-src') ||
                    img.currentSrc ||
                    img.src ||
                    ''
                ).trim())
                .filter(Boolean)
            : [];

        const htmlSources = extractImageSourcesFromHtml(root.innerHTML || '');
        return Array.from(new Set([...domSources, ...htmlSources]));
    }

    function extractPlainTextFromNode(root) {
        if (!root) {
            return '';
        }

        const rawText = String(
            root.innerText ||
            root.textContent ||
            ''
        );

        return rawText
            .replace(/\u00a0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function getQuestionContentRoot(container) {
        const selectors = [
            '.question-standalone-main-content .question-standalone-content-box azt-dynamic-hook',
            '.question-standalone-main-content .question-standalone-content-box ngx-dynamic-hooks',
            '.question-standalone-main-content .question-standalone-content-box',
            '.question-standalone-content-box azt-dynamic-hook',
            '.question-standalone-content-box ngx-dynamic-hooks',
            '.question-standalone-content-box',
            'azt-dynamic-hook',
            'ngx-dynamic-hooks'
        ];

        for (const selector of selectors) {
            const found = container.querySelector(selector);
            if (found) {
                return found;
            }
        }

        return null;
    }

    function hasExtractableQuestionContent(container) {
        const questionRoot = getQuestionContentRoot(container);
        const text = extractPlainTextFromNode(questionRoot);
        const images = getImageSources(questionRoot);
        return Boolean(text || images.length);
    }

    function findAnswerByLabel(answers, label) {
        const normalized = normalizeAnswerLabel(label);
        return answers.find(item => normalizeAnswerLabel(item.label) === normalized) || null;
    }

    function createDownload(filename, data) {
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    function extractJsonFromText(text) {
        if (!text) {
            return null;
        }

        const direct = safeJsonParse(text, null);
        if (direct) {
            return direct;
        }

        const fencedMatch = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
        if (fencedMatch && fencedMatch[1]) {
            return safeJsonParse(fencedMatch[1].trim(), null);
        }

        const firstBrace = text.indexOf('{');
        const lastBrace = text.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            return safeJsonParse(text.slice(firstBrace, lastBrace + 1), null);
        }

        return null;
    }

    function getConfiguredApiProviders() {
        const legacyProviders = (
            CONFIG.API_BASE_URL &&
            CONFIG.API_KEY &&
            CONFIG.API_KEY !== 'YOUR_API_KEY_HERE'
        )
            ? [{
                name: 'Legacy Provider',
                baseUrl: CONFIG.API_BASE_URL,
                apiKey: CONFIG.API_KEY,
                models: [CONFIG.MODEL || 'gpt-4o-mini']
            }]
            : [];

        const rawProviders = Array.isArray(CONFIG.API_PROVIDERS) && CONFIG.API_PROVIDERS.length
            ? CONFIG.API_PROVIDERS
            : legacyProviders;

        return rawProviders
            .map((provider, providerIndex) => {
                if (!provider || typeof provider !== 'object') {
                    return null;
                }

                const baseUrl = String(provider.baseUrl || provider.API_BASE_URL || '').trim();
                const apiKey = String(provider.apiKey || provider.API_KEY || '').trim();
                const models = Array.isArray(provider.models)
                    ? provider.models
                        .map(model => String(model || '').trim())
                        .filter(Boolean)
                    : [];

                if (!baseUrl || !apiKey || apiKey === 'YOUR_API_KEY_HERE' || !models.length) {
                    return null;
                }

                return {
                    name: String(provider.name || `Provider ${providerIndex + 1}`).trim(),
                    baseUrl,
                    apiKey,
                    models
                };
            })
            .filter(Boolean);
    }

    function getApiCandidateKey(candidate) {
        if (!candidate) {
            return '';
        }

        return [
            String(candidate.baseUrl || '').trim(),
            String(candidate.model || '').trim(),
            String(candidate.providerName || '').trim()
        ].join('::');
    }

    function setPreferredApiCandidate(candidate) {
        const nextKey = getApiCandidateKey(candidate);
        preferredApiCandidateKey = nextKey;

        if (nextKey) {
            console.log(`[API] Ghi nhớ candidate ưu tiên trong phiên hiện tại: ${candidate.providerName} / ${candidate.model}`);
        }
    }

    function reorderCandidatesByPreference(candidates) {
        if (!preferredApiCandidateKey || !Array.isArray(candidates) || candidates.length <= 1) {
            return Array.isArray(candidates) ? [...candidates] : [];
        }

        const ordered = [...candidates];
        const preferredIndex = ordered.findIndex(candidate => getApiCandidateKey(candidate) === preferredApiCandidateKey);

        if (preferredIndex <= 0) {
            return ordered;
        }

        const [preferredCandidate] = ordered.splice(preferredIndex, 1);
        ordered.unshift(preferredCandidate);

        console.log(`[API] Ưu tiên dùng candidate đã ghi nhớ: ${preferredCandidate.providerName} / ${preferredCandidate.model}`);
        return ordered;
    }

    function getApiCandidateList() {
        const candidates = [];

        getConfiguredApiProviders().forEach((provider, providerIndex) => {
            provider.models.forEach((model, modelIndex) => {
                candidates.push({
                    providerName: provider.name,
                    providerIndex,
                    modelIndex,
                    baseUrl: provider.baseUrl,
                    apiKey: provider.apiKey,
                    model
                });
            });
        });

        return reorderCandidatesByPreference(candidates);
    }

    // =============================
    // OFFLINE DATASET
    // =============================
    function getOfflineDataset() {
        const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
        const parsed = safeJsonParse(raw, []);
        return Array.isArray(parsed) ? parsed : [];
    }

    function saveOfflineDataset(items) {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(items));
    }

    function clearOfflineDataset() {
        localStorage.removeItem(CONFIG.STORAGE_KEY);
    }

    function normalizeImportedDataset(jsonData) {
        let items = [];

        if (Array.isArray(jsonData)) {
            items = jsonData;
        } else if (jsonData && Array.isArray(jsonData.items)) {
            items = jsonData.items;
        } else {
            throw new Error('JSON phải là mảng hoặc object có field "items" là mảng');
        }

        const normalizedItems = items
            .map((item, index) => {
                if (!item || typeof item !== 'object') {
                    return null;
                }

                const question = String(item.question || item.title || '').trim();
                const answers = normalizeAnswers(item.answers || item.options || []);
                const correctAnswer = normalizeAnswerLabel(item.correctAnswer || item.correct || item.answerKey || '');
                const correctAnswerText = String(item.correctAnswerText || item.answerText || '').trim();

                if (!question) {
                    console.warn(`[IMPORT] Bỏ qua item #${index + 1} vì thiếu question`);
                    return null;
                }

                const normalizedItem = {
                    question,
                    answers,
                    correctAnswer,
                    correctAnswerText
                };

                if (!normalizedItem.correctAnswer && normalizedItem.correctAnswerText && answers.length > 0) {
                    const matched = answers.find(answer => normalizeText(answer.text) === normalizeText(normalizedItem.correctAnswerText));
                    if (matched) {
                        normalizedItem.correctAnswer = matched.label;
                    }
                }

                return normalizedItem;
            })
            .filter(Boolean);

        if (!normalizedItems.length) {
            throw new Error('Không có bản ghi hợp lệ nào trong file JSON');
        }

        return normalizedItems;
    }

    function importDatasetFromFile() {
        return new Promise((resolve, reject) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';

            input.onchange = async event => {
                try {
                    const file = event.target.files && event.target.files[0];
                    if (!file) {
                        reject(new Error('Không có file nào được chọn'));
                        return;
                    }

                    const text = await file.text();
                    const jsonData = JSON.parse(text);
                    const normalizedItems = normalizeImportedDataset(jsonData);
                    saveOfflineDataset(normalizedItems);
                    resolve({
                        count: normalizedItems.length,
                        fileName: file.name
                    });
                } catch (error) {
                    reject(error);
                }
            };

            input.click();
        });
    }

    function findBestOfflineMatch(questionText) {
        const dataset = getOfflineDataset();
        let bestMatch = null;

        dataset.forEach(item => {
            const score = getSimilarityScore(questionText, item.question);
            if (!bestMatch || score > bestMatch.score) {
                bestMatch = {
                    item,
                    score
                };
            }
        });

        if (!bestMatch || bestMatch.score < CONFIG.MATCH_THRESHOLD) {
            return null;
        }

        return bestMatch;
    }

    // =============================
    // AZOTA EXTRACTION
    // Chỉ dùng lại cách tương tác với giao diện Azota từ file gốc
    // =============================
    function extractQuizData() {
        const quizzes = [];
        console.log('[AZOTA] Bắt đầu quét câu hỏi trên trang...');

        const questionContainers = document.querySelectorAll('azt-question-standalone-for-student-at-full-test');
        console.log(`[AZOTA] Tìm thấy ${questionContainers.length} container câu hỏi`);

        questionContainers.forEach((container, index) => {
            try {
                const questionRoot = getQuestionContentRoot(container);
                const questionElement = container.querySelector('.question-standalone-content-box span.ng-star-inserted, azt-dynamic-hook span.ng-star-inserted');
                const questionText = questionElement
                    ? extractPlainTextFromNode(questionElement)
                    : extractPlainTextFromNode(questionRoot);
                const questionImages = getImageSources(questionRoot);

                console.log(`[AZOTA] Câu #${index + 1} -> questionText="${questionText}" | questionImages=${questionImages.length}`);

                if (!questionText && !questionImages.length) {
                    console.warn(`[AZOTA] Bỏ qua câu #${index + 1} vì không đọc được nội dung hoặc hình ảnh`);
                    return;
                }

                const answers = [];
                const answerElements = {};
                const answerItems = container.querySelectorAll('.item-answer');

                answerItems.forEach((item, answerIndex) => {
                    const button = item.querySelector('button');
                    const answerContentContainer = item.querySelector('.answer-content');
                    const answerContent = item.querySelector('.answer-content span.ng-star-inserted');

                    if (button && answerContentContainer) {
                        const rawAnswerText = answerContent
                            ? extractPlainTextFromNode(answerContent)
                            : extractPlainTextFromNode(answerContentContainer);
                        const answerImages = getImageSources(answerContentContainer);

                        const label = normalizeAnswerLabel(button.textContent.trim() || String.fromCharCode(65 + answerIndex));
                        answers.push({
                            label,
                            text: rawAnswerText,
                            images: answerImages
                        });

                        answerElements[label] = {
                            item,
                            button,
                            answerContent,
                            answerContentContainer
                        };
                    }
                });

                quizzes.push({
                    questionNumber: index + 1,
                    question: questionText || '[Câu hỏi dạng hình ảnh]',
                    questionImages,
                    answers,
                    container,
                    answerElements
                });
            } catch (error) {
                console.error(`[AZOTA] Lỗi khi xử lý câu #${index + 1}:`, error);
            }
        });

        console.log(`[AZOTA] Hoàn thành quét: ${quizzes.length} câu hỏi hợp lệ`);
        return quizzes;
    }

    function markCorrectAnswerOnUI(questionItem, correctAnswerLabel, source = 'resolved') {
        if (!questionItem || !questionItem.answerElements) {
            return;
        }

        const normalizedLabel = normalizeAnswerLabel(correctAnswerLabel);
        const target = questionItem.answerElements[normalizedLabel];

        if (!target || (!target.answerContentContainer && !target.answerContent)) {
            console.warn(`[UI] Không tìm thấy phần tử đáp án ${normalizedLabel} cho câu #${questionItem.questionNumber}`);
            return;
        }

        const contentTarget = target.answerContentContainer || target.answerContent;
        if (!contentTarget) {
            console.warn(`[UI] Không có node nội dung để cập nhật cho đáp án ${normalizedLabel} ở câu #${questionItem.questionNumber}`);
            return;
        }

        if (contentTarget.dataset.azotaCorrectMarked === 'true') {
            console.log(`[UI] Đáp án ${normalizedLabel} của câu #${questionItem.questionNumber} đã được đánh dấu trước đó`);
            return;
        }

        const visibleText = (contentTarget.textContent || '').trimEnd();
        if (!visibleText) {
            console.warn(`[UI] Nội dung đáp án ${normalizedLabel} của câu #${questionItem.questionNumber} đang rỗng`);
            return;
        }

        contentTarget.textContent = `${visibleText}..`;
        contentTarget.dataset.azotaCorrectMarked = 'true';

        console.log(`[UI] Đã thêm ".." vào sau đáp án đúng ${normalizedLabel} cho câu #${questionItem.questionNumber} từ nguồn ${source}`);
    }

    // =============================
    // OPENAI-COMPATIBLE API
    // =============================
    function buildApiPrompt(questionItem) {
        const questionImages = Array.isArray(questionItem.questionImages) ? questionItem.questionImages : [];
        const answersText = questionItem.answers
            .map(answer => {
                const imageHint = Array.isArray(answer.images) && answer.images.length
                    ? ` (Hình ảnh: ${answer.images.join(', ')})`
                    : '';
                return `${answer.label}. ${answer.text || '[Đáp án dạng hình ảnh]'}${imageHint}`;
            })
            .join('\n');

        return [
            'Bạn là trợ lý phân tích câu hỏi trắc nghiệm.',
            'Hãy sử dụng chức năng tìm kiếm trên internet để trả về kết quả đúng nhất!',
            'Hãy xác định đáp án đúng nhất cho câu hỏi bên dưới.',
            'Nếu câu hỏi là hình ảnh, hãy phân tích hình ảnh đi kèm để suy ra đáp án.',
            'Chỉ trả về JSON hợp lệ, không thêm giải thích ngoài JSON.',
            'Schema bắt buộc:',
            '{',
            '  "correctAnswer": "A",',
            '  "confidence": 0.0,',
            '  "explanation": "ngắn gọn"',
            '}',
            '',
            'Question:',
            questionItem.question || '[Câu hỏi dạng hình ảnh]',
            ...(questionImages.length ? ['', `Question Images: ${questionImages.join(', ')}`] : []),
            '',
            'Answers:',
            answersText
        ].join('\n');
    }

    function buildApiUserContent(questionItem) {
        const prompt = buildApiPrompt(questionItem);
        const questionImages = Array.isArray(questionItem.questionImages) ? questionItem.questionImages : [];

        if (!questionImages.length) {
            return prompt;
        }

        return [
            {
                type: 'text',
                text: prompt
            },
            ...questionImages.map(url => ({
                type: 'image_url',
                image_url: {
                    url
                }
            }))
        ];
    }

    function createHealthcheckQuestionItem() {
        return {
            questionNumber: 0,
            question: 'Health check: Chọn đáp án A để xác nhận API đang hoạt động bình thường.',
            answers: [
                { label: 'A', text: 'A' },
                { label: 'B', text: 'B' }
            ]
        };
    }

    function requestOpenAIOnce(questionItem, candidate) {
        return new Promise((resolve, reject) => {
            if (!candidate || !candidate.baseUrl || !candidate.apiKey || !candidate.model) {
                reject(new Error('Chưa cấu hình candidate API hợp lệ'));
                return;
            }

            const url = candidate.baseUrl.replace(/\/+$/, '') + '/chat/completions';
            const body = {
                model: candidate.model,
                temperature: 0,
                response_format: { type: 'json_object' },
                messages: [
                    {
                        role: 'system',
                        content: 'Bạn là trợ lý chỉ được trả về JSON hợp lệ.'
                    },
                    {
                        role: 'user',
                        content: buildApiUserContent(questionItem)
                    }
                ]
            };

            GM_xmlhttpRequest({
                method: 'POST',
                url,
                timeout: CONFIG.REQUEST_TIMEOUT_MS,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${candidate.apiKey}`
                },
                data: JSON.stringify(body),
                onload: function(response) {
                    try {
                        if (response.status < 200 || response.status >= 300) {
                            reject(new Error(`HTTP ${response.status}: ${response.responseText || 'API request failed'}`));
                            return;
                        }

                        const data = JSON.parse(response.responseText);
                        const content = data?.choices?.[0]?.message?.content;

                        if (!content) {
                            reject(new Error('Không tìm thấy nội dung phản hồi từ API'));
                            return;
                        }

                        const parsed = extractJsonFromText(content);
                        if (!parsed || !parsed.correctAnswer) {
                            reject(new Error('Không parse được JSON hợp lệ từ phản hồi API'));
                            return;
                        }

                        const correctAnswer = normalizeAnswerLabel(parsed.correctAnswer);
                        const matchedAnswer = findAnswerByLabel(questionItem.answers, correctAnswer);

                        if (!matchedAnswer) {
                            reject(new Error(`API trả về đáp án "${correctAnswer}" nhưng không tồn tại trong lựa chọn hiện tại`));
                            return;
                        }

                        resolve({
                            source: 'api',
                            provider: candidate.providerName,
                            providerIndex: candidate.providerIndex,
                            model: candidate.model,
                            modelIndex: candidate.modelIndex,
                            correctAnswer: matchedAnswer.label,
                            correctAnswerText: matchedAnswer.text,
                            confidence: Number(parsed.confidence || 0),
                            explanation: String(parsed.explanation || '').trim()
                        });
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: function(error) {
                    reject(new Error(error?.error || 'Lỗi mạng khi gọi API'));
                },
                ontimeout: function() {
                    reject(new Error('API timeout'));
                }
            });
        });
    }

    async function requestOpenAIWithRetry(questionItem) {
        const candidates = getApiCandidateList();

        if (!candidates.length) {
            throw new Error('Chưa cấu hình API provider/model hợp lệ');
        }

        let lastError = null;
        let totalAttempts = 0;

        for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
            const candidate = candidates[candidateIndex];

            for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
                totalAttempts += 1;

                try {
                    console.log(
                        `[API] Câu #${questionItem.questionNumber} -> provider ${candidate.providerIndex + 1}/${getConfiguredApiProviders().length} (${candidate.providerName}) -> model ${candidate.modelIndex + 1} (${candidate.model}) -> lần thử ${attempt}/${CONFIG.MAX_RETRIES}`
                    );

                    const result = await requestOpenAIOnce(questionItem, candidate);
                    setPreferredApiCandidate(candidate);

                    return {
                        ...result,
                        attemptsUsed: totalAttempts,
                        attemptsUsedOnCurrentModel: attempt,
                        fallbackChainLength: candidates.length,
                        preferredCandidateKey: getApiCandidateKey(candidate)
                    };
                } catch (error) {
                    lastError = error;
                    console.warn(
                        `[API] Lỗi câu #${questionItem.questionNumber} với ${candidate.providerName} / ${candidate.model}, lần ${attempt}/${CONFIG.MAX_RETRIES}: ${error.message}`
                    );

                    if (attempt < CONFIG.MAX_RETRIES) {
                        const delay = randomBetween(CONFIG.RETRY_DELAY_MIN_MS, CONFIG.RETRY_DELAY_MAX_MS);
                        console.log(`[API] Chờ ${delay}ms trước khi thử lại cùng model...`);
                        await sleep(delay);
                    }
                }
            }

            if (candidateIndex < candidates.length - 1) {
                console.warn(
                    `[API] Chuyển sang fallback tiếp theo cho câu #${questionItem.questionNumber}: sau ${candidate.providerName} / ${candidate.model}`
                );
            }
        }

        throw lastError || new Error('Tất cả provider/model đều thất bại');
    }

    async function testAllConfiguredApis() {
        const providers = getConfiguredApiProviders();
        const candidates = getApiCandidateList();

        if (!candidates.length) {
            console.warn('[API TEST] Không có provider/model hợp lệ để test');
            showNotification('Không có API provider/model hợp lệ để test', 'warning', 5000);
            return;
        }

        const healthcheckQuestion = createHealthcheckQuestionItem();
        const summary = {
            startedAt: new Date().toISOString(),
            totalProviders: providers.length,
            totalCandidates: candidates.length,
            successCount: 0,
            failedCount: 0,
            results: []
        };

        console.group('[API TEST] Bắt đầu test nhanh tất cả provider/model');
        console.log('[API TEST] Danh sách provider hợp lệ:', providers);
        showNotification(`Đang test ${candidates.length} provider/model, xem Console để theo dõi`, 'info', 5000);

        for (let index = 0; index < candidates.length; index++) {
            const candidate = candidates[index];
            const startedAt = Date.now();

            console.log(
                `[API TEST] [${index + 1}/${candidates.length}] Đang test ${candidate.providerName} / ${candidate.model} ...`
            );

            try {
                const result = await requestOpenAIOnce(healthcheckQuestion, candidate);
                const durationMs = Date.now() - startedAt;

                summary.successCount += 1;
                summary.results.push({
                    status: 'success',
                    provider: candidate.providerName,
                    providerIndex: candidate.providerIndex,
                    model: candidate.model,
                    modelIndex: candidate.modelIndex,
                    durationMs,
                    response: {
                        correctAnswer: result.correctAnswer,
                        confidence: result.confidence,
                        explanation: result.explanation
                    }
                });

                console.log(
                    `[API TEST] OK -> ${candidate.providerName} / ${candidate.model} (${durationMs}ms)`,
                    result
                );
            } catch (error) {
                const durationMs = Date.now() - startedAt;

                summary.failedCount += 1;
                summary.results.push({
                    status: 'failed',
                    provider: candidate.providerName,
                    providerIndex: candidate.providerIndex,
                    model: candidate.model,
                    modelIndex: candidate.modelIndex,
                    durationMs,
                    error: error.message
                });

                console.error(
                    `[API TEST] FAIL -> ${candidate.providerName} / ${candidate.model} (${durationMs}ms): ${error.message}`
                );
            }
        }

        summary.finishedAt = new Date().toISOString();
        console.log('[API TEST] Tổng kết:', summary);
        console.groupEnd();

        if (summary.failedCount > 0) {
            showNotification(
                `Test API xong: ${summary.successCount} OK, ${summary.failedCount} lỗi. Xem Console để biết chi tiết`,
                'warning',
                7000
            );
            return;
        }

        showNotification(`Test API xong: ${summary.successCount}/${summary.totalCandidates} cấu hình hoạt động tốt`, 'success', 7000);
    }

    // =============================
    // RESOLUTION PIPELINE
    // =============================
    function resolveFromOffline(questionItem) {
        const bestMatch = findBestOfflineMatch(questionItem.question);

        if (!bestMatch) {
            return null;
        }

        const { item, score } = bestMatch;
        let correctAnswer = normalizeAnswerLabel(item.correctAnswer);
        let correctAnswerText = '';

        if (correctAnswer) {
            const matched = findAnswerByLabel(questionItem.answers, correctAnswer);
            if (matched) {
                correctAnswerText = matched.text;
            }
        }

        if (!correctAnswer && item.correctAnswerText) {
            const normalizedExpected = normalizeText(item.correctAnswerText);
            let bestAnswer = null;

            questionItem.answers.forEach(answer => {
                const scoreText = getSimilarityScore(answer.text, normalizedExpected);
                if (!bestAnswer || scoreText > bestAnswer.score) {
                    bestAnswer = {
                        answer,
                        score: scoreText
                    };
                }
            });

            if (bestAnswer && bestAnswer.score >= CONFIG.MATCH_THRESHOLD) {
                correctAnswer = bestAnswer.answer.label;
                correctAnswerText = bestAnswer.answer.text;
            }
        }

        if (!correctAnswer) {
            return null;
        }

        if (!correctAnswerText) {
            const matched = findAnswerByLabel(questionItem.answers, correctAnswer);
            correctAnswerText = matched ? matched.text : '';
        }

        return {
            source: 'offline',
            similarity: score,
            correctAnswer,
            correctAnswerText,
            explanation: 'Khớp từ bộ dữ liệu offline'
        };
    }

    async function resolveQuestion(questionItem) {
        try {
            const apiResult = await requestOpenAIWithRetry(questionItem);
            return {
                questionNumber: questionItem.questionNumber,
                question: questionItem.question,
                answers: questionItem.answers,
                result: apiResult,
                status: 'resolved'
            };
        } catch (apiError) {
            console.warn(`[RESOLVE] API thất bại cho câu #${questionItem.questionNumber}: ${apiError.message}`);
            const offlineResult = resolveFromOffline(questionItem);

            if (offlineResult) {
                return {
                    questionNumber: questionItem.questionNumber,
                    question: questionItem.question,
                    answers: questionItem.answers,
                    result: {
                        ...offlineResult,
                        apiError: apiError.message
                    },
                    status: 'resolved'
                };
            }

            return {
                questionNumber: questionItem.questionNumber,
                question: questionItem.question,
                answers: questionItem.answers,
                status: 'unresolved',
                error: apiError.message
            };
        }
    }

    async function processQuiz() {
        if (isProcessing) {
            showNotification('Đang xử lý, vui lòng chờ...', 'warning');
            return false;
        }

        isProcessing = true;

        try {
            showNotification('Đang đọc câu hỏi từ Azota...', 'info');
            const quizItems = extractQuizData();

            if (!quizItems.length) {
                hasAutoProcessed = false;
                showNotification('Không tìm thấy câu hỏi hợp lệ trên trang', 'warning');
                return false;
            }

            console.log(`[PROCESS] Bắt đầu xử lý ${quizItems.length} câu hỏi...`);

            const results = [];
            for (let i = 0; i < quizItems.length; i++) {
                const item = quizItems[i];
                showNotification(`Đang xử lý câu ${i + 1}/${quizItems.length}...`, 'info', 1500);
                const resolved = await resolveQuestion(item);

                if (resolved.status === 'resolved' && resolved.result && resolved.result.correctAnswer) {
                    markCorrectAnswerOnUI(item, resolved.result.correctAnswer, resolved.result.source);
                }

                results.push(resolved);
            }

            lastResolvedResults = results;
            console.log('[PROCESS] Hoàn thành. Dữ liệu đã được lưu trong bộ nhớ:', results);
            showNotification(`Đã xử lý ${results.length} câu hỏi. Nhấn Ctrl+Shift+E để xuất JSON`, 'success', 5000);
            return true;
        } catch (error) {
            hasAutoProcessed = false;
            console.error('[PROCESS] Lỗi xử lý tổng:', error);
            showNotification(`Lỗi: ${error.message}`, 'error', 5000);
            return false;
        } finally {
            isProcessing = false;
        }
    }

    function exportResolvedResults() {
        if (!lastResolvedResults.length) {
            showNotification('Chưa có dữ liệu để xuất. Nhấn Ctrl+Shift+R để xử lý câu hỏi trước', 'warning', 5000);
            return;
        }

        const summary = {
            generatedAt: new Date().toISOString(),
            totalQuestions: lastResolvedResults.length,
            resolvedCount: lastResolvedResults.filter(item => item.status === 'resolved').length,
            unresolvedCount: lastResolvedResults.filter(item => item.status === 'unresolved').length,
            config: {
                matchThreshold: CONFIG.MATCH_THRESHOLD,
                maxRetries: CONFIG.MAX_RETRIES,
                configuredProviders: getConfiguredApiProviders().length,
                configuredModels: getApiCandidateList().length
            }
        };

        const exportData = {
            summary,
            items: lastResolvedResults
        };

        const filename = `${CONFIG.EXPORT_FILE_PREFIX}_${timestampForFilename()}.json`;
        createDownload(filename, exportData);

        console.log('[EXPORT] Hoàn thành. Dữ liệu:', exportData);
        showNotification(`Đã xuất ${lastResolvedResults.length} câu hỏi ra file JSON`, 'success', 5000);
    }

    function tryAutoProcessQuiz() {
        if (hasAutoProcessed || isProcessing) {
            return;
        }

        const questionContainers = document.querySelectorAll('azt-question-standalone-for-student-at-full-test');
        if (!questionContainers.length) {
            return;
        }

        const readyContainers = Array.from(questionContainers).filter(container => hasExtractableQuestionContent(container));
        if (!readyContainers.length) {
            console.log(`[AUTO] Đã thấy ${questionContainers.length} container nhưng nội dung câu hỏi chưa render xong, tiếp tục chờ...`);
            return;
        }

        hasAutoProcessed = true;
        console.log(`[AUTO] Phát hiện ${readyContainers.length}/${questionContainers.length} câu hỏi đã sẵn sàng, bắt đầu xử lý tự động...`);

        if (autoProcessObserver) {
            autoProcessObserver.disconnect();
            autoProcessObserver = null;
        }

        processQuiz();
    }

    function startAutoProcessWatcher() {
        tryAutoProcessQuiz();

        if (hasAutoProcessed) {
            return;
        }

        autoProcessObserver = new MutationObserver(() => {
            tryAutoProcessQuiz();
        });

        autoProcessObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        console.log('[AUTO] Đã bật chế độ theo dõi để tự động xử lý khi danh sách câu hỏi xuất hiện');
    }

    // =============================
    // KEYBOARD SHORTCUTS
    // =============================
    async function handleKeyDown(event) {
        if (event.ctrlKey && event.shiftKey && (event.key === 'I' || event.key === 'i')) {
            event.preventDefault();
            try {
                const result = await importDatasetFromFile();
                console.log(`[IMPORT] Đã import ${result.count} câu từ file ${result.fileName}`);
                showNotification(`Đã import ${result.count} câu hỏi từ ${result.fileName}`, 'success', 5000);
            } catch (error) {
                console.error('[IMPORT] Lỗi import:', error);
                showNotification(`Import lỗi: ${error.message}`, 'error', 5000);
            }
            return;
        }

        if (event.ctrlKey && event.shiftKey && (event.key === 'R' || event.key === 'r')) {
            event.preventDefault();
            processQuiz();
            return;
        }

        if (event.ctrlKey && event.shiftKey && (event.key === 'E' || event.key === 'e')) {
            event.preventDefault();
            exportResolvedResults();
            return;
        }

        if (event.ctrlKey && event.shiftKey && (event.key === 'G' || event.key === 'g')) {
            event.preventDefault();
            testAllConfiguredApis();
            return;
        }

        if (event.ctrlKey && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
            event.preventDefault();
            clearOfflineDataset();
            console.log('[OFFLINE] Đã xóa dataset offline');
            showNotification('Đã xóa dữ liệu offline đã lưu', 'success');
        }
    }

    // =============================
    // INIT
    // =============================
    document.addEventListener('keydown', handleKeyDown);
    startAutoProcessWatcher();

    console.log('[INIT] Azota Quiz OpenAI Exporter đã sẵn sàng');
    console.log('[INIT] Tự động xử lý khi phát hiện danh sách câu hỏi');
    console.log('[INIT] Ctrl+Shift+I = import JSON offline');
    console.log('[INIT] Ctrl+Shift+R = xử lý thủ công lại nếu cần');
    console.log('[INIT] Ctrl+Shift+E = xuất JSON từ dữ liệu đã xử lý');
    console.log('[INIT] Ctrl+Shift+G = test nhanh tất cả API provider/model, xem kết quả trong Console');
    console.log('[INIT] Ctrl+Shift+D = xóa JSON offline');

    showNotification('Script sẵn sàng: tự động xử lý khi phát hiện câu hỏi, Ctrl+Shift+E để export', 'success', 5000);
})();