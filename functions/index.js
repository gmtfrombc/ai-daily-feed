/**
 * Firebase Cloud Functions for ai_daily_feed
 */

// Load environment variables (like OPENAI_API_KEY)
require('dotenv').config();

const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require('firebase-admin');
const { OpenAI } = require('openai');
const cors = require('cors')({ origin: true }); // Use ({origin: true}) for simple config
const { FieldValue } = require('firebase-admin/firestore'); // Explicit import for FieldValue
const { getDocs, collection, query, orderBy, doc, getDoc, updateDoc } = require('firebase-admin/firestore');

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Initialize OpenAI Client
let openai;
if (process.env.OPENAI_API_KEY) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    logger.info("OpenAI client initialized.");
} else {
    logger.error("OpenAI API key not found in environment variables. Text generation will fail.");
    // You might want to throw an error here or handle it gracefully depending on requirements
}


// --- Core Article Generation Logic --- //
async function generateArticleLogic() {
    logger.info("Starting article generation process...");

    // --- 1. Select a Topic from Firestore (with history check) ---
    let selectedTopicDoc = null;
    let selectedTopicId = null;
    let selectedLessonId = null;
    let topicTitle = null;
    let sourceText = null;

    try {
        // Get all available topic IDs efficiently using select()
        const topicsRef = db.collection('topics');
        const allTopicsSnapshot = await topicsRef.select().get(); // Fetch only IDs
        if (allTopicsSnapshot.empty) {
            logger.error("No topics found in the 'topics' collection.");
            return;
        }
        const allTopicIds = allTopicsSnapshot.docs.map(doc => doc.id);
        logger.info(`Found ${allTopicIds.length} total topics.`);

        // Get recently used topic IDs from topic_history (e.g., last N topics, maybe half the total?)
        const historyLookbackCount = Math.max(1, Math.floor(allTopicIds.length / 2)); // Look back ~half the topics
        const historyRef = db.collection('topic_history');
        const historyQuery = historyRef.orderBy('usedAt', 'desc').limit(historyLookbackCount);
        const historySnapshot = await historyQuery.get();
        const recentTopicIds = historySnapshot.docs.map(doc => doc.data().topicId);
        logger.info(`Found ${recentTopicIds.length} topics in recent history (lookback: ${historyLookbackCount}).`);

        // Filter out recent topics
        let availableTopicIds = allTopicIds.filter(id => !recentTopicIds.includes(id));
        logger.info(`Found ${availableTopicIds.length} topics available after filtering history.`);

        // Handle case where all topics were used recently (cycle is complete)
        if (availableTopicIds.length === 0) {
            logger.warn("All topics used recently or list empty. Selecting randomly from ALL topics as fallback.");
            availableTopicIds = allTopicIds; // Fallback to using all IDs
            if (availableTopicIds.length === 0) { // Should not happen if initial check passed
                logger.error("CRITICAL: No topics available even in fallback.");
                return;
            }
        }

        // Select a random topic ID from the *available* list
        const randomIndex = Math.floor(Math.random() * availableTopicIds.length);
        selectedTopicId = availableTopicIds[randomIndex];
        logger.info(`Randomly selected available topic ID: ${selectedTopicId}`);

        // Fetch the full document for the selected topic
        const topicDocRef = db.collection('topics').doc(selectedTopicId);
        selectedTopicDoc = await topicDocRef.get();

        if (!selectedTopicDoc.exists) {
            // This could happen if a topic was deleted between getting IDs and fetching
            logger.error(`Selected topic document with ID ${selectedTopicId} no longer exists.`);
            return; // Or potentially retry selection?
        }

        // Extract data (moved here for clarity)
        const topicData = selectedTopicDoc.data();
        selectedLessonId = topicData.lessonId;
        topicTitle = topicData.title;
        sourceText = topicData.content;

        logger.info(`Successfully fetched selected topic: Title="${topicTitle}", LessonID=${selectedLessonId}`);

        if (!sourceText || !topicTitle || !selectedLessonId) {
            logger.error(`Topic document ${selectedTopicId} is missing title, content, or lessonId.`);
            return;
        }

    } catch (error) {
        logger.error("Error during topic selection process:", error);
        return; // Stop execution on error
    }
    // --- End of Topic Selection ---

    // --- 2. Fetch Corresponding Lesson Image URL ---
    let selectedImageUrl = null;
    try {
        const lessonDocRef = db.collection('lessons').doc(selectedLessonId);
        const lessonDoc = await lessonDocRef.get();
        if (lessonDoc.exists && lessonDoc.data().imageUrl) {
            selectedImageUrl = lessonDoc.data().imageUrl;
            logger.info(`Found image URL for lesson ${selectedLessonId}: ${selectedImageUrl}`);
        } else {
            logger.warn(`Image URL not found for lesson ID: ${selectedLessonId}. Draft will have no image.`);
        }
    } catch (error) {
        logger.error(`Error fetching lesson document ${selectedLessonId}:`, error);
        // Continue without image if lesson fetch fails
    }

    // --- 3. Construct Prompt for OpenAI & Generate Text ---
    let generatedContent = "";
    let generatedTitle = `Daily Feed: ${topicTitle}`;

    if (!openai) { // Check if OpenAI client failed to initialize
        logger.error("OpenAI client not available. Skipping text generation.");
        // Use placeholder content or stop?
        generatedContent = "[AI text generation failed - API key missing]";
    } else {
        const systemMessage = "You are an expert health writer for a lifestyle change program. Your role is to create clear, informative, and engaging content that helps patients understand and apply health concepts in their daily lives.";
        const userPrompt = `Create a 50-100 word short article based on the following text about '${topicTitle}'. 
        Writing style guidelines:
        - Write in a clear, conversational tone
        - Address the reader directly but professionally
        - Focus on practical insights and a simple, actionable takeaway
        - Don't use hype, buzzwords, and exclamation points
        - Don't use greetings or marketing phrases
        - Address a single core message and insights from the source text
        
        Source text:
        ---
        ${sourceText}
        ---
        
        Output only the article text, ready for publication.`;
        try {
            logger.info("Calling OpenAI API for text generation...");
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
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
                generatedContent = "[AI text generation failed - No response choice]"; // Placeholder on failure
            }
        } catch (error) {
            logger.error("Error calling OpenAI API:", error);
            generatedContent = "[AI text generation failed - API error]"; // Placeholder on failure
        }
    }

    // --- 4. Save Draft to Firestore (including Image URL) ---
    let draftRefId = null; // Variable to hold the new draft ID for history update
    try {
        const draftData = {
            title: generatedTitle,
            content: generatedContent,
            topicId: selectedTopicId,
            topicTitle: topicTitle,
            lessonId: selectedLessonId,
            imageUrl: selectedImageUrl || null,
            status: "pending",
            createdAt: FieldValue.serverTimestamp(),
        };
        logger.info("Attempting to save draft data:", { data: draftData });
        const draftRef = await db.collection('drafts').add(draftData);
        draftRefId = draftRef.id; // Capture the ID of the newly created draft
        logger.info(`Draft save attempt successful. Document ID: ${draftRefId}`);

    } catch (error) {
        logger.error("FATAL Error during Firestore draft save:", error);
        // If draft save fails, we should NOT update history
        return; // Stop execution if draft cannot be saved
    }

    // --- 5. Update Topic History (AFTER successful draft save) ---
    if (draftRefId && selectedTopicId) { // Ensure we have IDs needed
        try {
            const historyData = {
                topicId: selectedTopicId,
                topicTitle: topicTitle, // Optional: store title for easier debugging
                draftId: draftRefId,   // Optional: link to the generated draft
                lessonId: selectedLessonId || null, // Optional
                usedAt: FieldValue.serverTimestamp()
            };
            await db.collection('topic_history').add(historyData);
            logger.info(`Successfully updated topic_history for topic ID: ${selectedTopicId}`);
        } catch (historyError) {
            // Log failure to update history, but don't necessarily stop the whole process
            // The main goal (generating the draft) succeeded.
            logger.error(`Error updating topic_history for topic ${selectedTopicId}:`, historyError);
        }
    } else {
        logger.warn("Skipping topic_history update because draftRefId or selectedTopicId was missing.");
    }

    logger.info("Article generation process finished.");
}

// --- Core Daily Feed Rotation Logic --- //
async function rotateDailyFeedLogic() {
    logger.info("Starting daily feed rotation process...");

    try {
        // 1. Get all published articles, sorted by orderIndex
        const articlesRef = db.collection('published_articles');
        const q = articlesRef.orderBy('orderIndex', 'asc');
        const articlesSnapshot = await q.get();

        if (articlesSnapshot.empty) {
            logger.warn("No published articles found. Cannot rotate feed.");
            return;
        }

        const sortedArticles = articlesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const articleCount = sortedArticles.length;
        logger.info(`Found ${articleCount} published articles ordered by index.`);

        if (articleCount <= 1) {
            logger.info("Only one or zero published articles. No rotation needed.");
            // Ensure the single article (if it exists) is set as current
            if (articleCount === 1) {
                const singleArticleId = sortedArticles[0].id;
                const configRef = db.collection('current_config').doc('live_article');
                const configSnap = await configRef.get();
                if (!configSnap.exists() || configSnap.data().currentArticleId !== singleArticleId) {
                    logger.info(`Setting the single article ${singleArticleId} as current.`);
                    await configRef.set({ currentArticleId: singleArticleId }, { merge: true }); // Use set with merge
                }
            }
            return;
        }

        // 2. Get the current live article ID
        const configRef = db.collection('current_config').doc('live_article');
        const configSnap = await configRef.get();

        let currentArticleId = null;
        let currentIndex = -1;

        if (configSnap.exists()) {
            currentArticleId = configSnap.data().currentArticleId;
            logger.info(`Current live article ID: ${currentArticleId}`);
            // Find the index of the current article in the sorted list
            currentIndex = sortedArticles.findIndex(article => article.id === currentArticleId);
        } else {
            logger.warn("live_article config document not found. Will set the first article as current.");
            // If config doesn't exist, we'll default to the first article (index 0)
        }

        if (currentIndex === -1 && currentArticleId) {
            logger.warn(`Current article ID ${currentArticleId} not found in published list. Defaulting to first article.`);
            // Reset index if current ID is invalid or not found
        }

        // 3. Determine the next article index (wrap around)
        const nextIndex = (currentIndex + 1) % articleCount;
        const nextArticle = sortedArticles[nextIndex];
        const nextArticleId = nextArticle.id;

        logger.info(`Calculated next article index: ${nextIndex}, ID: ${nextArticleId}`);

        // 4. Update the config if the next article is different
        if (nextArticleId !== currentArticleId) {
            await configRef.set({ currentArticleId: nextArticleId }, { merge: true }); // Use set with merge to create/update
            logger.info(`Successfully updated live_article config to point to: ${nextArticleId}`);
        } else {
            logger.info("Next article ID is the same as current. No update needed.");
        }

    } catch (error) {
        logger.error("Error during daily feed rotation:", error);
        // Consider adding alerting here
    }
    logger.info("Daily feed rotation process finished.");
}


// --- Function Triggers --- //

// HTTP Trigger (for manual testing/regeneration)
exports.generateArticleHttp = onRequest(
    { timeoutSeconds: 540, memory: '1GiB' },
    async (request, response) => { // Make the main handler async
        // Handle CORS first
        cors(request, response, async () => {
            logger.info("HTTP trigger invoked (via CORS).", { origin: request.get('origin') });

            // --- Authentication Check ---
            const authorizationHeader = request.headers.authorization || '';
            if (!authorizationHeader.startsWith('Bearer ')) {
                logger.warn('Unauthorized: No Bearer token provided.');
                response.status(403).send('Unauthorized: Missing authorization token.');
                return;
            }

            const idToken = authorizationHeader.split('Bearer ')[1];
            let decodedToken;
            try {
                decodedToken = await admin.auth().verifyIdToken(idToken);
                logger.info("ID Token verified successfully for UID:", decodedToken.uid);

                // --- Authorization Check (Optional but Recommended) ---
                // Check if the user has the isAdmin claim
                if (decodedToken.isAdmin !== true) {
                    logger.warn(`Forbidden: User ${decodedToken.uid} is not an admin.`);
                    response.status(403).send('Forbidden: User does not have admin privileges.');
                    return;
                }
                // --- End Authorization Check ---

            } catch (error) {
                logger.error('Error verifying ID token:', error);
                response.status(403).send('Unauthorized: Invalid or expired token.');
                return;
            }
            // --- End Authentication Check ---

            // --- Proceed only if authenticated (and authorized) ---
            try {
                logger.info(`Admin user ${decodedToken.uid} triggering generation.`); // Log admin action
                await generateArticleLogic();
                response.send("Article generation process triggered successfully.");
            } catch (error) {
                logger.error("Error in HTTP trigger execution after auth:", error);
                response.status(500).send("An error occurred during article generation.");
            }
        });
    });

// Scheduled Trigger (Example: Runs every day at 9:00 AM America/New_York)
// exports.generateArticleScheduled = onSchedule(
//   { schedule: "every day 09:00", timezone: "America/New_York", timeoutSeconds: 540, memory: '1GiB' },
//   async (event) => {
//     logger.info("Scheduled trigger invoked.", { scheduleTime: event.scheduleTime });
//     try {
//       await generateArticleLogic();
//       logger.info("Scheduled article generation finished successfully.");
//     } catch (error) {
//       logger.error("Error in scheduled trigger execution:", error);
//       // Add monitoring/alerting here if needed for scheduler failures
//     }
//   }
// );

// NEW Scheduled Trigger for Feed Rotation
exports.rotateDailyFeedScheduled = onSchedule(
    // Run every day at midnight (00:00) in New York timezone
    { schedule: "every day 00:00", timezone: "America/New_York", timeoutSeconds: 300, memory: '1GiB' },
    async (event) => {
        logger.info("Scheduled feed rotation trigger invoked.", { scheduleTime: event.scheduleTime });
        await rotateDailyFeedLogic();
        logger.info("Scheduled feed rotation finished successfully.");
        // Note: Error handling happens within rotateDailyFeedLogic
    }
);
