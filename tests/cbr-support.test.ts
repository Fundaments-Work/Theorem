import { describe, expect, it } from 'vitest';
import {
    detectFormatFromBuffer,
    getBookFormat,
    isSupportedImportFilename,
} from '../src/core/lib/import';
import { FIXED_LAYOUT_FORMATS, FORMAT_DISPLAY_NAMES } from '../src/core/types';

describe('CBR Comic Archive Support', () => {
    it('detects CBR from filename extensions case-insensitively', () => {
        expect(getBookFormat('comic.cbr')).toBe('cbr');
        expect(getBookFormat('/path/to/Amazing Spider-Man 001.CBR')).toBe('cbr');
        expect(getBookFormat('C:\\Users\\Comics\\Batman.cbr')).toBe('cbr');
    });

    it('identifies .cbr as a supported import filename', () => {
        expect(isSupportedImportFilename('comic.cbr')).toBe(true);
        expect(isSupportedImportFilename('COMIC.CBR')).toBe(true);
        expect(isSupportedImportFilename('issue_12.cbr')).toBe(true);
    });

    it('detects CBR format from RAR signature buffer bytes', () => {
        // RAR4 / RAR5 magic signature begins with: 52 61 72 21 1A 07
        const rarHeader = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00, 0x00]);
        expect(detectFormatFromBuffer(rarHeader.buffer)).toBe('cbr');

        const rar5Header = new Uint8Array([0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00]);
        expect(detectFormatFromBuffer(rar5Header.buffer)).toBe('cbr');
    });

    it('includes cbr in FIXED_LAYOUT_FORMATS and FORMAT_DISPLAY_NAMES', () => {
        expect(FIXED_LAYOUT_FORMATS).toContain('cbr');
        expect(FORMAT_DISPLAY_NAMES.cbr).toBe('CBR');
    });
});
