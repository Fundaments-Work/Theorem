import { Dropdown } from 'theorem';

const FORMATS = [
    { value: 'epub', label: 'EPUB' },
    { value: 'pdf', label: 'PDF' },
    { value: 'mobi', label: 'MOBI' },
    { value: 'rss', label: 'RSS feed' },
];

export function Default() {
    return <Dropdown options={FORMATS} placeholder="Select format…" />;
}

export function WithSelection() {
    return <Dropdown options={FORMATS} defaultValue="epub" />;
}

export function OutlinedSmall() {
    return <Dropdown options={FORMATS} variant="outlined" size="sm" defaultValue="pdf" />;
}

export function Disabled() {
    return <Dropdown options={FORMATS} defaultValue="epub" disabled />;
}
