/**
 * Offscreen document: the control connection.
 *
 * One per Chrome profile. Holds the long-lived connection to the daemon because neither the
 * service worker nor a terminal page can. Notifications and daemon-initiated tab actions
 * originate here. See docs/06-chrome-integration.md.
 */
export {};
