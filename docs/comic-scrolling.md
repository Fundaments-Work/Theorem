# Comic scrolling

CBR and CBZ readers offer **Settings → Layout → Scroll**, alongside Paged mode. Scroll mode displays one continuous vertical strip: images fit the reading width and touch edge-to-edge, with no added margins, separators, or page-turn gestures. White borders already present inside an image remain part of that image.

The comic archive and page order remain unchanged. A rendition copy selects the continuous comic renderer, while the original cached book retains its fixed-layout rendition for Paged mode. Nearby pages load ahead of the viewport, decoding is limited to two images at once, and distant images are released while retaining their measured aspect ratios. Renderer changes are serialized and restore the current comic page. Synthetic position ranges keep page and within-page offsets compatible with Foliate's CFI persistence.

Regression tests cover ordering, limited loading, eviction, aspect ratios, real Foliate CFI restoration, bad-page retries, disposal, boundary navigation, mode changes, and CBR/CBZ settings. A real-browser test also verifies touching images and scrolling across their boundary. Physical-device validation is recorded in the Android CBR issue.
