import { openai } from "./openai.js";

export async function extractCandidateMetadata(rawText) {
    const prompt = `
Extract structured candidate profile from this CV text.

Return JSON only with keys:
full_name, current_title, years_experience, skills, summary

Rules:
- years_experience must be integer if possible
- skills should be comma-separated string
- summary should be 1-2 sentences
- if a field is unknown, return null

CV TEXT:
${rawText}
`;

    const response = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
            {
                role: "user",
                content: prompt,
            },
        ],
    });

    return JSON.parse(response.choices[0].message.content);
}