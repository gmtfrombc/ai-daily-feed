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
const cors = require('cors');

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

    // --- 1. Select a Topic from Firestore (with history check) ---
    let selectedTopicDoc = null;
    let selectedTopicId = null;
    try {
        // Get all available topic IDs
        const topicsRef = db.collection('topics');
        // Use select() to only fetch IDs initially for efficiency
        const allTopicsSnapshot = await topicsRef.select().get();
        if (allTopicsSnapshot.empty) {
            logger.error("No topics found in the 'topics' collection.");
            return;
        }
        const allTopicIds = allTopicsSnapshot.docs.map(doc => doc.id);
        logger.info(`Found ${allTopicIds.length} total topics.`);

        // Get recently used topic IDs from topic_history (e.g., last 10)
        const historyRef = db.collection('topic_history');
        const historyQuery = historyRef.orderBy('usedAt', 'desc').limit(10); // Adjust limit as needed
        const historySnapshot = await historyQuery.get();
        const recentTopicIds = historySnapshot.docs.map(doc => doc.data().topicId);
        logger.info(`Found ${recentTopicIds.length} recent topics in history: ${recentTopicIds.join(', ')}`);

        // Filter out recent topics
        let availableTopicIds = allTopicIds.filter(id => !recentTopicIds.includes(id));
        logger.info(`Found ${availableTopicIds.length} topics available after filtering history.`);

        // Handle case where all topics were used recently
        if (availableTopicIds.length === 0) {
            logger.warn("All topics have been used recently. Selecting randomly from all available topics as a fallback.");
            // Fallback: use all topics if the filtered list is empty
            availableTopicIds = allTopicIds;
            if (availableTopicIds.length === 0) {
                logger.error("CRITICAL: No topics available even in fallback.");
                return;
            }
        }

        // Select a random topic ID from the available list
        const randomIndex = Math.floor(Math.random() * availableTopicIds.length);
        selectedTopicId = availableTopicIds[randomIndex];
        logger.info(`Randomly selected topic ID: ${selectedTopicId}`);

        // Fetch the full document for the selected topic
        const topicDocRef = db.collection('topics').doc(selectedTopicId);
        selectedTopicDoc = await topicDocRef.get();

        if (!selectedTopicDoc.exists) {
            logger.error(`Selected topic document with ID ${selectedTopicId} does not exist (this shouldn't happen).`);
            return;
        }
        logger.info(`Successfully fetched selected topic: Title="${selectedTopicDoc.data().title}"`);

    } catch (error) {
        logger.error("Error during topic selection:", error);
        return; // Stop execution on error
    }

    // Extract data (moved after successful fetch)
    const topicData = selectedTopicDoc.data();
    const sourceText = topicData.content;
    const topicTitle = topicData.title;
    const lessonId = topicData.lessonId; // Assuming lessonId field exists

    if (!sourceText || !topicTitle) {
        logger.error(`Topic document ${selectedTopicId} is missing title or content.`);
        return;
    }

    // --- 2. Construct Prompt for OpenAI ---
    // System message defines the AI's role and general behavior
    const systemMessage = "You are an expert health writer for a lifestyle change program. Your role is to create clear, informative, and engaging content that helps patients understand and apply health concepts in their daily lives.";

    // User prompt contains the specific task, style guidelines, and source text
    const userPrompt = `Create a 100-150 word article based on the following text about '${topicTitle}'. 
    Writing style guidelines:
    - Write in a clear, conversational tone
    - Address the reader directly but professionally
    - Focus on practical insights and actionable takeaways
    - Avoid hype, buzzwords, and exclamation points
    - Don't use greetings or marketing phrases
    - Maintain the core message and insights from the source text
    
    Source text:
    ---
    ${sourceText}
    ---
    
    Output only the article text, ready for publication.`;

    // --- 3. Call OpenAI API (GPT-4) ---
    let generatedContent = "";
    // Use the topic title for the draft title, or refine if needed
    let generatedTitle = `Daily Feed: ${topicTitle}`;
    try {
        logger.info("Calling OpenAI API...");
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                { role: "system", content: systemMessage },
                { role: "user", content: userPrompt }
            ],
            max_tokens: 500,
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
    let draftRefId = null; // To store the ID for history update
    try {
        const draftData = {
            title: generatedTitle,
            content: generatedContent,
            topicId: selectedTopicId, // Use the selected ID
            topicTitle: topicTitle,
            lessonId: lessonId || null, // Store reference to the lesson
            status: "pending",
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        const draftRef = await db.collection('drafts').add(draftData);
        draftRefId = draftRef.id; // Store the new draft ID
        logger.info(`Draft saved successfully with ID: ${draftRefId}`);

        // --- 5. Update Topic History ---
        // Add entry to topic_history only *after* draft is saved
        const historyData = {
            topicId: selectedTopicId,
            topicTitle: topicTitle, // Optional: store title for easier debugging
            draftId: draftRefId,   // Optional: link to the generated draft
            usedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await db.collection('topic_history').add(historyData);
        logger.info(`Updated topic_history for topic ID: ${selectedTopicId}`);

    } catch (error) {
        logger.error("Error saving draft or updating topic history:", error);
        // Decide if partial failure needs specific handling
        // If draft saved but history failed, the topic might be picked again sooner than expected.
    }

    logger.info("Article generation process finished.");
}

// --- Function Triggers --- //

// HTTP Trigger (for manual testing via URL)
exports.generateArticleHttp = onRequest(
    { timeoutSeconds: 540, memory: '1GiB' },
    (request, response) => {
        // Define allowed origins for this function
        const allowedOrigins = ['http://localhost:8080', 'https://ai-daily-feed.web.app'];

        // Create and apply CORS middleware for this specific request
        const corsHandler = cors({ origin: allowedOrigins });

        corsHandler(request, response, async () => {
            // --- Log Incoming Headers (for debugging auth) ---
            logger.info("Incoming request headers:", request.headers);

            // --- Manual Authentication Check --- 
            let decodedToken = null;
            const authorizationHeader = request.headers.authorization;

            if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
                logger.warn("Unauthorized: No or invalid Authorization header.", { headers: request.headers });
                response.status(401).send("Unauthorized: Missing or malformed Authorization header.");
                return;
            }

            const idToken = authorizationHeader.split('Bearer ')[1];

            try {
                // Verify the ID token using Firebase Admin SDK
                decodedToken = await admin.auth().verifyIdToken(idToken);
                logger.info(`Successfully verified token for user: ${decodedToken.uid}`);
            } catch (error) {
                logger.error("Error verifying Firebase ID token:", error);
                response.status(403).send("Forbidden: Invalid or expired authentication token.");
                return;
            }

            // At this point, decodedToken is valid and contains user info (e.g., decodedToken.uid)
            // We no longer need the platform-populated request.auth check
            // if (!request.auth) { ... } // REMOVED

            // --- Proceed with function logic if token is verified --- 
            try {
                await generateArticleLogic();
                response.send("Article generation process triggered successfully. Check logs and Firestore 'drafts' collection.");
            } catch (error) {
                logger.error("Error in HTTP trigger execution:", error);
                response.status(500).send("An error occurred during article generation.");
            }
        });
    });

// Scheduled Trigger (commented out)
// exports.generateArticleScheduled = onSchedule(...);
