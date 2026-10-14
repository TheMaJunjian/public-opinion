// Test environment setup
// This file runs before every test file.

import '@testing-library/jest-dom';

Object.defineProperty(window, 'matchMedia', {
	writable: true,
	value: (query: string) => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: () => {},
		removeListener: () => {},
		addEventListener: () => {},
		removeEventListener: () => {},
		dispatchEvent: () => false,
	}),
});

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

Object.defineProperty(window, 'ResizeObserver', {
	writable: true,
	value: TestResizeObserver,
});

Element.prototype.scrollIntoView = () => {};
