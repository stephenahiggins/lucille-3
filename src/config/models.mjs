export const modelEnv = Object.freeze({
  local: "LUCILLE_LOCAL_MODEL",
  openai: "LUCILLE_OPENAI_MODEL",
  evaluation: "LUCILLE_EVAL_MODELS",
  evaluationBaseline: "LUCILLE_EVAL_BASELINE_MODEL"
});

export function resolveLocalModel(options = {}) {
  return resolveModel(options.value, {
    env: options.env,
    key: modelEnv.local,
    label: "local visual model"
  });
}

export function resolveOpenAIModel(options = {}) {
  return resolveModel(options.value, {
    env: options.env,
    key: modelEnv.openai,
    label: "OpenAI synthesis model"
  });
}

export function resolveEvaluationModels(options = {}) {
  const env = options.env ?? process.env;
  const value = options.value ?? env[modelEnv.evaluation];
  if (typeof value === "string") {
    const models = value.split(",").map((model) => model.trim()).filter(Boolean);
    if (models.length > 0) return [...new Set(models)];
  }
  if (Array.isArray(value) && value.length > 0) return [...new Set(value.map(String).map((model) => model.trim()).filter(Boolean))];
  throw new Error(`Set ${modelEnv.evaluation} in .env or pass --models with at least one model.`);
}

export function resolveEvaluationBaselineModel(options = {}) {
  return resolveModel(options.value, {
    env: options.env,
    key: modelEnv.evaluationBaseline,
    label: "model evaluation baseline label"
  });
}

function resolveModel(value, { env = process.env, key, label }) {
  const resolved = value ?? env[key];
  if (typeof resolved === "string" && resolved.trim() !== "") {
    return resolved.trim();
  }
  throw new Error(`Set ${key} in .env or pass an explicit ${label}.`);
}
