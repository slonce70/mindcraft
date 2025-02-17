export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;
        
        let stopAttemptStart = Date.now();
        const TIMEOUT_MS = 10000; // 10 seconds timeout
        const MAX_UNSTUCK_ATTEMPTS = 3;
        let unstuckAttempts = 0;
        
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                if (this.executing) {
                    console.log('Action timeout reached. Attempting to unstuck...');
                    this._attemptUnstuck().then(() => {
                        this.executing = false;
                        resolve();
                    });
                }
            }, TIMEOUT_MS);
        });

        const stopAttemptPromise = (async () => {
            while (this.executing && (Date.now() - stopAttemptStart) < TIMEOUT_MS) {
                if (unstuckAttempts < MAX_UNSTUCK_ATTEMPTS) {
                    this.agent.requestInterrupt();
                    console.log('waiting for code to finish executing...');
                    await new Promise(resolve => setTimeout(resolve, 300));
                    
                    // If still stuck after waiting, try to unstuck
                    if (this.executing && (Date.now() - stopAttemptStart) > 2000) {
                        console.log(`Unstuck attempt ${unstuckAttempts + 1}/${MAX_UNSTUCK_ATTEMPTS}`);
                        await this._attemptUnstuck();
                        unstuckAttempts++;
                    }
                } else {
                    console.log('Max unstuck attempts reached. Forcing stop.');
                    this.executing = false;
                    break;
                }
            }
        })();

        // Wait for either normal stop or timeout
        await Promise.race([stopAttemptPromise, timeoutPromise]);
        
        this.currentActionLabel = '';
        this.currentActionFn = null;
    } 

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.on || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        try {
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this._getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted && !this.agent.coder.generating) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            console.error("Code execution triggered catch:", err);
            // Log the full stack trace
            console.error(err.stack);
            await this.stop();
            err = err.toString();

            let message = this._getBotOutputSummary() +
                '!!Code threw exception!!\n' +
                'Error: ' + err + '\n' +
                'Stack trace:\n' + err.stack+'\n';

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted && !this.agent.coder.generating) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted, timedout: false };
        }
    }

    _getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Code output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Code output:\n' + output.toString();
        }
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

    async _attemptUnstuck() {
        try {
            const bot = this.agent.bot;
            if (!bot) return;

            // First try using the existing moveAway function
            try {
                const skills = require('./library/skills');
                await skills.moveAway(bot, 2);
                if (!this.executing) return; // Successfully moved away
            } catch (moveError) {
                console.log('moveAway failed, trying basic movement patterns:', moveError);
                
                // Fall back to basic movement patterns if moveAway fails
                const movements = [
                    async () => {
                        bot.setControlState('forward', true);
                        bot.setControlState('jump', true);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        bot.setControlState('forward', false);
                        bot.setControlState('jump', false);
                    },
                    async () => {
                        bot.setControlState('back', true);
                        await new Promise(resolve => setTimeout(resolve, 500));
                        bot.setControlState('back', false);
                    },
                    async () => {
                        bot.setControlState('left', true);
                        await new Promise(resolve => setTimeout(resolve, 300));
                        bot.setControlState('left', false);
                    },
                    async () => {
                        bot.setControlState('right', true);
                        await new Promise(resolve => setTimeout(resolve, 300));
                        bot.setControlState('right', false);
                    }
                ];

                // Try each movement pattern
                for (const movement of movements) {
                    if (!this.executing) break; // Stop if action was cancelled
                    await movement();
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
            }

            // Clear all control states
            bot.clearControlStates();
        } catch (error) {
            console.error('Error in unstuck attempt:', error);
        }
    }
}