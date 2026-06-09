document.addEventListener('mouseup', () => {
    let highlightedText = window.getSelection().toString().trim();
    if (highlightedText.length > 0) {
        chrome.runtime.sendMessage({type: 'NEW_HIGHLIGHT', text: highlightedText});
    }
});