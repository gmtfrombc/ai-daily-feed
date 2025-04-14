/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// Load environment variables (like OPENAI_API_KEY)
require('dotenv').config();

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler"); // For scheduled runs
const logger = require("firebase-functions/logger");
const admin = require('firebase-admin');
const { OpenAI } = require('openai');

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Initialize OpenAI Client
if (!process.env.OPENAI_API_KEY) {
    logger.error("OpenAI API key not found in environment variables.");
}
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

// Create and deploy your first functions
// https://firebase.google.com/docs/functions/get-started

// exports.helloWorld = onRequest((request, response) => {
//   logger.info("Hello logs!", {structuredData: true});
//   response.send("Hello from Firebase!");
// });

// --- Placeholder for Article Generation Logic --- //
// This function will contain the core logic for fetching source, calling OpenAI, and saving draft
async function generateArticleLogic() {
    logger.info("Starting article generation process...");

    // --- 1. Select a Topic from Firestore ---
    let selectedTopicDoc = null;
    try {
        // Simple approach: Get the first topic found. Refine later for randomness/history.
        const topicsRef = db.collection('topics');
        const topicsQuery = topicsRef.limit(1);
        const querySnapshot = await topicsQuery.get();

        if (querySnapshot.empty) {
            logger.error("No topics found in the 'topics' collection.");
            return; // Stop if no source topics exist
        } else {
            selectedTopicDoc = querySnapshot.docs[0];
            logger.info(`Selected topic: ID=${selectedTopicDoc.id}, Title="${selectedTopicDoc.data().title}"`);
        }
    } catch (error) {
        logger.error("Error fetching topic document:", error);
        return; // Stop execution on error
    }

    const topicData = selectedTopicDoc.data();
    const sourceText = topicData.content;
    const topicTitle = topicData.title;
    const topicId = selectedTopicDoc.id;
    const lessonId = topicData.lessonId; // Assuming lessonId field exists

    if (!sourceText || !topicTitle) {
        logger.error(`Topic document ${topicId} is missing title or content.`);
        return;
    }

    // --- 2. Construct Prompt for OpenAI ---
    const prompt = `Summarize the following text about "${topicTitle}". Keep it concise (around 150-250 words) and maintain a similar style/tone for a daily feed. Output only the summary text:\n\n---\n${sourceText}\n---`;

    // --- 3. Call OpenAI API (GPT-4) ---
    let generatedContent = "";
    // Use the topic title for the draft title, or refine if needed
    let generatedTitle = `Daily Feed: ${topicTitle}`;
    try {
        logger.info("Calling OpenAI API...");
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: "You are a helpful assistant creating concise daily health summaries." },
                { role: "user", content: prompt }
            ],
            max_tokens: 300,
            temperature: 0.7,
        });

        if (response.choices && response.choices.length > 0) {
            generatedContent = response.choices[0].message.content.trim();
            logger.info(`Received generated content (length: ${generatedContent.length})`);
        } else {
            logger.error("OpenAI response did not contain expected choices.");
            return;
        }
    } catch (error) {
        logger.error("Error calling OpenAI API:", error);
        return;
    }

    // --- 4. Save Draft to Firestore ---
    try {
        const draftData = {
            title: generatedTitle,
            content: generatedContent,
            topicId: topicId, // Store reference to the source topic
            topicTitle: topicTitle,
            lessonId: lessonId || null, // Store reference to the lesson
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        const draftRef = await db.collection('drafts').add(draftData);
        logger.info(`Draft saved successfully with ID: ${draftRef.id}`);

        // TODO: Optionally update topic_history here

    } catch (error) {
        logger.error("Error saving draft to Firestore:", error);
    }

    logger.info("Article generation process finished.");
}


// --- Function Triggers --- //

// HTTP Trigger (for manual testing via URL)
exports.generateArticleHttp = onRequest(
    { timeoutSeconds: 540, memory: '1GiB' },
    async (request, response) => {
        logger.info("HTTP trigger invoked.");
        try {
            await generateArticleLogic();
            response.send("Article generation process triggered successfully. Check logs and Firestore 'drafts' collection.");
        } catch (error) {
            logger.error("Error in HTTP trigger execution:", error);
            response.status(500).send("An error occurred during article generation.");
        }
    });

// Scheduled Trigger (commented out)
// exports.generateArticleScheduled = onSchedule(...);
