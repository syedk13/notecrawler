chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type == 'NEW_HIGHLIGHT') {
        (async () => {
            if (!message.text?.trim()) {
                const errorMsg = 'No text provided for summarization.';
                console.error(errorMsg);
                sendResponse({error: errorMsg});
                return;
            }

            const originalText = message.text;
            try {
                const result = await chrome.storage.local.get('highlightedHistory');
                const history = result.highlightedHistory || [];
                history.push({original: originalText, timestamp: Date.now()});
                await chrome.storage.local.set({highlightedHistory: history});
            } catch (error) {
                console.error('Error saving highlight to storage:', error);
                sendResponse({error: 'Failed to save highlight to storage.'});
                return; 
            }
            
            // Forward the summary to the Side Panel
            try {
                chrome.runtime.sendMessage({type: 'HIGHLIGHT_ADDED', text: originalText});
            } catch (error) {
                console.error('Error sending message to Side Panel:', error);
                sendResponse({error: 'Failed to send message to Side Panel.'});
                return;
            }

            sendResponse({success: true}); 

        })();         
    }

    return true; // Ensures the message channel doesn't close before async operations complete  
});