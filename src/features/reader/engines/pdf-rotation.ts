/**
 * Rotation to pass to `page.getViewport()`. pdf.js uses the value as the
 * page's *total* rotation (it defaults to the page's own /Rotate), so the
 * viewer's rotation must be added to /Rotate, not passed instead of it;
 * otherwise pages the PDF marks as rotated (common in scans) show sideways.
 */
export function viewRotation(page: { rotate: number }, userRotation: number): number {
    return (((page.rotate + userRotation) % 360) + 360) % 360;
}
