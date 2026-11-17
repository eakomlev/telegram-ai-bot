// Do not load developer .env (including real tokens/prices) during tests.
process.env.DOTENV_CONFIG_PATH = '__test_env_not_present__';
process.env.TELEGRAM_BOT_TOKEN = 'test';
process.env.OPENAI_API_KEY = 'test';
process.env.OPENAI_INPUT_USD_PER_1M_TOKENS = '2';
process.env.OPENAI_OUTPUT_USD_PER_1M_TOKENS = '10';
process.env.OPENAI_IMAGE_USD = '0.011';
process.env.AUTO_ANSWER_CLAIM_LEASE_MS = '180000';
process.env.PROCESS_MAX_STDOUT_BYTES = String(4 * 1024 * 1024);
