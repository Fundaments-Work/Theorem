/**
 * Toolbar button classes shared by the Library and Shelves pages, so the two toolbars cannot
 * drift apart. They sit on top of the `ui-btn*` classes in design-tokens.css.
 */
export const TOOLBAR_BUTTON_BASE = "ui-btn disabled:opacity-50";
export const TOOLBAR_BUTTON_PRIMARY = "ui-btn-primary disabled:opacity-50";
/** 44px on touch screens (the minimum comfortable target), 40px with a pointer. */
export const TOOLBAR_ICON_BUTTON = "h-11 w-11 px-0 sm:h-10 sm:w-10";
