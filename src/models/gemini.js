import { GoogleGenerativeAI } from '@google/generative-ai';
import { toSinglePrompt, strictFormat } from '../utils/text.js';
import { getKey } from '../utils/keys.js';

export class Gemini {
    constructor(model_name, url, params) {
        this.model_name = model_name;
        this.params = params;
        this.url = url;
        this.safetySettings = [
            {
                "category": "HARM_CATEGORY_DANGEROUS",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_HARASSMENT",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_HATE_SPEECH",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                "threshold": "BLOCK_NONE",
            },
            {
                "category": "HARM_CATEGORY_DANGEROUS_CONTENT",
                "threshold": "BLOCK_NONE",
            },
        ];

        this.genAI = new GoogleGenerativeAI(getKey('GEMINI_API_KEY'));
    }

    async sendRequest(turns, systemMessage, stop_seq='***') {
        let model;
        const modelConfig = {
            model: this.model_name || "gemini-1.5-flash",
            // systemInstruction does not work bc google is trash
        };
        
        if (this.url) {
            model = this.genAI.getGenerativeModel(
                modelConfig,
                { baseUrl: this.url },
                { safetySettings: this.safetySettings }
            );
        } else {
            model = this.genAI.getGenerativeModel(
                modelConfig,
                { safetySettings: this.safetySettings }
            );
        }

        const maxRetries = 3;
        const retryDelay = 2000; // 2 seconds
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                console.log('Awaiting Google API response...');

                turns.unshift({ role: 'system', content: systemMessage });
                turns = strictFormat(turns);
                let contents = [];
                for (let turn of turns) {
                    contents.push({
                        role: turn.role === 'assistant' ? 'model' : 'user',
                        parts: [{ text: turn.content }]
                    });
                }

                const result = await model.generateContent({
                    contents,
                    generationConfig: {
                        ...(this.params || {})
                    }
                });
                const response = await result.response;
                const text = response.text();
                console.log('Received.');

                return text;
            } catch (error) {
                console.log(`API request attempt ${attempt} failed:`, error.message);
                
                if (error.message.includes('429') || error.message.includes('quota')) {
                    if (attempt < maxRetries) {
                        console.log(`Waiting ${retryDelay}ms before retry...`);
                        await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
                        continue;
                    }
                }
                
                // For other errors or if we've exhausted retries
                throw new Error(`Failed after ${attempt} attempts: ${error.message}`);
            }
        }
    }

    async embed(text) {
        let model;
        if (this.url) {
            model = this.genAI.getGenerativeModel(
                { model: "text-embedding-004" },
                { baseUrl: this.url }
            );
        } else {
            model = this.genAI.getGenerativeModel(
                { model: "text-embedding-004" }
            );
        }

        const result = await model.embedContent(text);
        return result.embedding.values;
    }
}