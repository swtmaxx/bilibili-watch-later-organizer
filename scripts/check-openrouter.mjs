import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./auto-llm-classify.js", import.meta.url), "utf8");

function readConfigString(name) {
  const match = source.match(new RegExp(name + ":\\s*([\"'`])([\\s\\S]*?)\\1"));
  return match ? match[2].trim() : "";
}

function readConfigNumber(name, fallback) {
  const match = source.match(new RegExp(name + ":\\s*([0-9.]+)"));
  return match ? Number(match[1]) : fallback;
}

const baseUrl = readConfigString("baseUrl");
const apiFormat = readConfigString("apiFormat") || "chat_completions";
const apiKey = readConfigString("apiKey");
const model = readConfigString("model");
const temperature = readConfigNumber("temperature", 0);
const useResponseFormat = /useResponseFormat:\s*true/.test(source);

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

if (!baseUrl) throw new Error("auto-llm-classify.js missing CONFIG.baseUrl");
if (!apiKey || apiKey === "YOUR_API_KEY_HERE") throw new Error("auto-llm-classify.js missing CONFIG.apiKey");
if (!model) throw new Error("auto-llm-classify.js missing CONFIG.model");

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
