//------------------------------------------------------------------------------
// Module-level variables
//------------------------------------------------------------------------------
const params = new URLSearchParams(window.location.search);
const player = document.createElement("replay-web-page");

//------------------------------------------------------------------------------
// Check for required params
//------------------------------------------------------------------------------
if (params.get("source") === null) {
  throw new Error("`source` search param must be provided.");
}

//------------------------------------------------------------------------------
// Prepare and inject `<replay-web-page>`
//------------------------------------------------------------------------------
player.setAttribute("source", `/${params.get("source")}`);
player.setAttribute("replayBase", "/replay-web-page/");
player.setAttribute("embed", "default");
player.setAttribute("requireSubDomainIframe", "");

// Param: `url` (see: https://replayweb.page/docs/embedding)
if (params.get("url")) {
  player.setAttribute("url", params.get("url"));
}

// Param: `ts` (see: https://replayweb.page/docs/embedding)
if (params.get("ts")) {
  player.setAttribute("ts", handleTsParam(params.get("ts")));
}

// Param: `embed` (see: https://replayweb.page/docs/embedding)
if (["default", "full", "replayonly", "replay-with-info"].includes(params.get("embed"))) {
  player.setAttribute("embed", params.get("embed"));
}

// Param: `deepLink` (see: https://replayweb.page/docs/embedding)
if (params.get("deepLink")) {
  player.setAttribute("deepLink", "");
}

// Param: `noSandbox` (see: https://replayweb.page/docs/embedding)
// Default to sandboxing playbacks, but allow the host to override.
if (!params.get("noSandbox")){
  player.setAttribute("sandbox", "");
}

document.querySelector("body").appendChild(player);

//------------------------------------------------------------------------------
// Two-way communication between embedder and embedded
//------------------------------------------------------------------------------
window.addEventListener("message", (event) => {
  //
  // Forward messages coming from the service worker
  //
  try {
    if (event.source.location.pathname === player.getAttribute("replayBase")) {
      parent.window.postMessage(
        { waczExhibitorHref: window.location.href, ...event.data },
        "*"
      );
    }
  }
  catch(err) {
    // Will fail on cross-origin messages
  }

  //
  // Handle messages coming from parent
  //
  if (event.source === parent.window && event.data) {

    // `updateUrl`: Updates `<replay-web-page>`s "url" attribute
    if (event.data["updateUrl"]) {
      player.setAttribute("url", event.data.updateUrl);
    }

    // `updateTs` Updates `<replay-web-page>`s "ts" attribute
    if (event.data["updateTs"]) {
      player.setAttribute("ts", handleTsParam(event.data.updateTs));
    }

    // `getInited`: Hoists current value of `<replay-web-page>.__inited`.
    // This value indicates whether or not the service worker is ready.
    if (event.data["getInited"]) {
      parent.window.postMessage(
        { inited: player.__inited, waczExhibitorHref: window.location.href },
        event.origin
      );
    }

    // `getCollInfo`
    // Pries into `<replay-web-page>` to hoist `wr-coll.__collInfo`, which contains useful collection-related data.
    if (event.data["getCollInfo"]) {
      let collInfo = {};

      try {
        collInfo = player.shadowRoot
          .querySelector("iframe")
          .contentDocument
          .querySelector("replay-app-main")
          .shadowRoot
          .querySelector("wr-coll")
          .__collInfo;
      }
      catch(err) {
        // console.log(err); // Not blocking | Just not ready.
      }

      parent.window.postMessage(
        { collInfo: collInfo, waczExhibitorHref: window.location.href },
        event.origin
      );
    }

    // `overrideElementAttribute`
    //
    // Controversial proposed feature to allow hosts to improve specific playback experiences
    // by altering the attributes of a targeted HTML element in the playback.
    //
    // Examples:
    // - adding missing `alt` attributes to images for improved accessibility
    // - hiding disruptive modals (like Facebook login prompts)
    // - calling attention to / "highlighting" a section of a playback
    //
    // Pries into `<replay-web-page>`, retrieves the element with the specified selector,
    // and applies the requested attribute.
    //
    // Delegates to the async helper function overrideElementAttribute
    if (event.data["overrideElementAttribute"]) {
      overrideElementAttribute(
        event.origin,
        player,
        parent,
        event.data["overrideElementAttribute"]["selector"],
        event.data["overrideElementAttribute"]["attributeName"],
        event.data["overrideElementAttribute"]["attributeContents"]
      );
    }
  }

}, false);

//------------------------------------------------------------------------------
// Utils
//------------------------------------------------------------------------------
/**
 * Converts `ts` from timestamp to YYYYMMDDHHMMSS if necessary.
 * In `<replay-web-page>`, `ts` can be either depending on context, which can lead to confusions.
 * This function brings support for `ts` as either a timestamp OR a formatted date.
 * 
 * @param {Number|String} ts 
 * @returns {Number} 
 */
function handleTsParam(ts) {
  ts = parseInt(ts);
  
  if (ts <= 9999999999999) {
    const date = new Date(ts);
    let newTs = `${date.getUTCFullYear()}`;
    newTs += `${(date.getUTCMonth() + 1).toString().padStart(2, 0)}`;
    newTs += `${date.getUTCDate().toString().padStart(2, 0)}`;
    newTs += `${date.getUTCHours().toString().padStart(2, 0)}`;
    newTs += `${date.getUTCMinutes().toString().padStart(2, 0)}`;
    newTs += `${date.getSeconds().toString().padStart(2, 0)}`;
    ts = newTs;
  }

  return ts;
}

/**
 * Waits for a given element to be in the DOM and returns it.
 * Wait is based on `requestAnimationFrame`: timeout is approximately 60 seconds (60 x 60 frames per seconds).
 *
 * Takes a function querying the DOM for a single element as an argument
 */
async function waitForElement(selectorFunction) {
  const maxPauseSeconds = 60
  let tries = maxPauseSeconds * 60;  // we expect a repaint rate of ~60 times a second, per https://developer.mozilla.org/en-US/docs/Web/API/window/requestAnimationFrame
  let elem = null;

  while (!elem && tries > 0) {
    // Sleep efficiently until the next repaint
    const pause = await new Promise(resolve => requestAnimationFrame(resolve));
    cancelAnimationFrame(pause);

    // Look for the target element
    try {
      elem = selectorFunction();
    }
    catch (err) {
      if (!err.message.includes('null')) {
        throw err;
      }
      tries -= 1;
    }
  }

  if (elem) {
    return elem;
  }

  throw new Error("Timed out");
}

/**
 * Async helper function for handling `overrideElementAttribute` messages.
 * Posts `overrideElementAttribute` back to the parent frame on failure.
 */
async function overrideElementAttribute(origin, player, parent, selector, attributeName, attributeContents){
  try {
    const targetElem = await waitForElement(() => {
      return player.shadowRoot
        .querySelector('iframe')
        .contentDocument
        .querySelector('replay-app-main')
        .shadowRoot
        .querySelector('wr-coll')
        .shadowRoot
        .querySelector('wr-coll-replay')
        .shadowRoot
        .querySelector('iframe')
        .contentDocument
        .querySelector(selector);
    })
    targetElem.setAttribute(attributeName, attributeContents);
  }
  catch(err) {
    if (!err.message.includes('Timed out')) {
      throw err;
    }
    parent.window.postMessage(
      {"overrideElementAttribute": {
        "status": "timed out",
        "request": event.data["overrideElementAttribute"],
        waczExhibitorHref: window.location.href
      }},
      origin
    );
  }
}
