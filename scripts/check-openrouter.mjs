const baseUrl = process.env.LLM_BASE_URL || "https://openrouter.ai/api/v1";
const apiFormat = process.env.LLM_API_FORMAT || "chat_completions";
const apiKey = process.env.LLM_API_KEY || "";
const model = process.env.LLM_MODEL || "";
const temperature = Number(process.env.LLM_TEMPERATURE || 0);
const useResponseFormat = process.env.LLM_USE_RESPONSE_FORMAT === "true";

function apiUrl(value, format) {
  const url = String(value || "").trim().replace(/\/+$/g, "");
  if (!url) return "";
  if (format === "responses") {
    if (/\/responses$/i.test(url)) return url;
    if (/\/chat\/completions$/i.test(url)) return url.replace(/\/chat\/completions$/i, "/responses");
    return url + "/responses";
  }
  if (/\/chat\/completions$/i.test(url)) return url;
  if (/\/responses$/i.test(url)) return url.replace(/\/responses$/i, "/chat/completions");
  return url + "/chat/completions";
}

if (!apiKey) throw new Error("LLM_API_KEY is required");
if (!model) throw new Error("LLM_MODEL is required");

const endpoint = apiUrl(baseUrl, apiFormat);
const requestBody = apiFormat === "responses"
  ? {
      model,
      temperature,
      instructions: "Return only JSON.",
      input: "Return only JSON: {\"items\":[{\"bvid\":\"BVtest\",\"categoryIds\":[\"other.todo\"],\"confidence\":0.5,\"reason\":\"test\"}]}"
    }
  : {
      model,
      temperature,
      messages: [
        { role: "user", content: "Return only JSON: {\"items\":[{\"bvid\":\"BVtest\",\"categoryIds\":[\"other.todo\"],\"confidence\":0.5,\"reason\":\"test\"}]}" }
      ]
    };
if (useResponseFormat) {
  if (apiFormat === "responses") requestBody.text = { format: { type: "json_object" } };
  else requestBody.response_format = { type: "json_object" };
}
const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": "Bearer " + apiKey,
    "x-title": "Bili Watchlater Classifier Check"
  },
  body: JSON.stringify(requestBody)
});

const text = await response.text();
console.log("baseUrl:", baseUrl);
console.log("endpoint:", endpoint);
console.log("apiFormat:", apiFormat);
console.log("model:", model);
console.log("httpStatus:", response.status);
console.log("ok:", response.ok);
console.log("bodyPreview:", text.slice(0, 500));

if (!response.ok) process.exitCode = 1;
