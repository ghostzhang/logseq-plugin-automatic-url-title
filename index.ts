import '@logseq/libs';

const DEFAULT_REGEX = {
    wrappedInCommand: /(\{\{(video)\s*(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})\s*\}\})/gi,
    htmlTitleTag: /<title(\s[^>]+)*>([^<]*)<\/title>/,
    line: /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9]+\.[^\s]{2,}|www\.[a-zA-Z0-9]+\.[^\s]{2,})/gi,
    imageExtension: /\.(gif|jpe?g|tiff?|png|webp|bmp|tga|psd|ai)$/i,
    iactionsURI: /((obsidian|cubox):\/\/.*[^\s]{2,})/i,
};

const FORMAT_SETTINGS = {
    markdown: {
        formatBeginning: '](',
        applyFormat: (title: string, url: string) => `[${title}](${url})`,
    },
    org: {
        formatBeginning: '][',
        applyFormat: (title: string, url: string) => `[[${url}][${title}]]`,
    },
};

function decodeHTML(input: string): string {
    if (!input) {
        return '';
    }

    const doc = new DOMParser().parseFromString(input, 'text/html');
    return doc.documentElement.textContent || '';
}

async function getTitle(url: string): Promise<string> {
    try {
        const response = await fetch(url);
        const responseText = await response.text();
        const matches = responseText.match(DEFAULT_REGEX.htmlTitleTag);
        if (matches !== null && matches.length > 1 && matches[2] !== null) {
            return decodeHTML(matches[2].trim());
        }
    } catch (e) {
        console.error(e);
    }

    return '';
}

async function convertUrlToMarkdownLink(url: string, text: string, urlStartIndex: number, offset: number, applyFormat: (title: string, url: string) => string) {
    const title = await getTitle(url);
    if (title === '') {
        return { text, offset };
    }

    const startSection = text.slice(0, urlStartIndex);
    const wrappedUrl = applyFormat(title, url);
    const endSection = text.slice(urlStartIndex + url.length);

    return {
        text: `${startSection}${wrappedUrl}${endSection}`,
        offset: urlStartIndex + url.length,
    };
}

function getIactionsURI(url: string) {
    const uriType = new RegExp(DEFAULT_REGEX.iactionsURI);
    const match = url.match(uriType);
    if (match && match.length > 0) {
        return match[2];
    }
    return null;
}

function isImage(url: string): boolean {
    const imageRegex = new RegExp(DEFAULT_REGEX.imageExtension);
    return imageRegex.test(url);
}

function isAlreadyFormatted(text: string, url: string, urlIndex: number, formatBeginning: string): boolean {
    return text.slice(urlIndex - 2, urlIndex) === formatBeginning;
}

function isWrappedInCommand(text: string, url: string): boolean {
    const wrappedLinks = text.match(DEFAULT_REGEX.wrappedInCommand);
    if (!wrappedLinks) {
        return false;
    }

    return wrappedLinks.some(command => command.includes(url));
}

async function getFormatSettings() {
    const { preferredFormat } = await logseq.App.getUserConfigs();
    if (!preferredFormat) {
        return null;
    }

    return FORMAT_SETTINGS[preferredFormat as keyof typeof FORMAT_SETTINGS];
}

async function parseBlockForLink(uuid: string): Promise<void> {
    if (!uuid) {
        return;
    }

    const rawBlock = await logseq.Editor.getBlock(uuid);
    if (!rawBlock) {
        return;
    }

    let text = rawBlock.content;
    const urls = text.match(DEFAULT_REGEX.line);
    if (!urls) {
        return;
    }

    const formatSettings = await getFormatSettings();
    if (!formatSettings) {
        return;
    }

    let offset = 0;
    for (const url of urls) {
        const urlIndex = text.indexOf(url, offset);

        if (isAlreadyFormatted(text, url, urlIndex, formatSettings.formatBeginning) || isImage(url) || isWrappedInCommand(text, url)) {
            continue;
        }

        const updatedTitle = await convertUrlToMarkdownLink(url, text, urlIndex, offset, formatSettings.applyFormat);
        text = updatedTitle.text;
        offset = updatedTitle.offset;
    }

    await logseq.Editor.updateBlock(uuid, text);
}

const main = async () => {
    logseq.provideStyle(`
    .external-link {
        padding: 2px 4px;
        border-radius: 3px;
        border: 0;
        text-decoration: underline;
        text-decoration-style: dashed;
        text-decoration-thickness: 1px;
        text-underline-offset: 2px;
    }
    .external-link-img {
        display: var(--favicons, inline-block);
        width: 16px;
        height: 16px;
        margin: -3px 7px 0 0;
    }`);

    const doc = parent.document;
    const appContainer = doc.getElementById('app-container');

    // External links favicons
    const setFavicon = (extLinkEl: HTMLAnchorElement) => {
        const oldFav = extLinkEl.querySelector('.external-link-img');
        const url = extLinkEl.href;

        if (oldFav) {
            oldFav.remove();
        }
        let { hostname } = new URL(url);
        if (hostname === '') {
            const uriType = getIactionsURI(url);
            if (uriType !== null) {
                switch (uriType) {
                    case 'obsidian':
                        hostname = 'obsidian.md';
                        break;
                    case 'cubox':
                        hostname = 'cubox.pro';
                        break;
                    default:
                        break;
                }
            }
        }

        const faviconValue = `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
        const fav = doc.createElement('img');
        fav.src = faviconValue;
        fav.width = 16;
        fav.height = 16;
        fav.classList.add('external-link-img');
        extLinkEl.insertAdjacentElement('afterbegin', fav);
    };

    // Favicons observer
    const extLinksObserverConfig = { childList: true, subtree: true };
    const extLinksObserver = new MutationObserver((mutationsList, observer) => {
        for (let i = 0; i < mutationsList.length; i++) {
            const addedNode = mutationsList[i].addedNodes[0] as Element;
            if (addedNode && addedNode.childNodes.length) {
                const extLinkList = addedNode.querySelectorAll('.external-link');
                if (extLinkList.length) {
                    extLinksObserver.disconnect();
                    for (let i = 0; i < extLinkList.length; i++) {
                        setFavicon(extLinkList[i] as HTMLAnchorElement);
                    }

                    extLinksObserver.observe(appContainer!, extLinksObserverConfig);
                }
            }
        }
    });

    setTimeout(() => {
        doc.querySelectorAll('.external-link')?.forEach(extLink => setFavicon(extLink as HTMLAnchorElement));
        extLinksObserver.observe(appContainer!, extLinksObserverConfig);
    }, 500);

    logseq.Editor.registerBlockContextMenuItem('Format url titles', async ({ uuid }) => {
        await parseBlockForLink(uuid);
        const extLinkList = doc.querySelectorAll('.external-link');
        extLinkList.forEach(extLink => setFavicon(extLink as HTMLAnchorElement));
    });

    const blockSet = new Set<string>();
    logseq.DB.onChanged(async (e) => {
        if (e.txMeta?.outlinerOp !== 'insertBlocks') {
            const uuid = e.blocks[0]?.uuid;
            if (uuid) {
                blockSet.add(uuid);
            }
            doc.querySelectorAll('.external-link')?.forEach(extLink => setFavicon(extLink as HTMLAnchorElement));
            return;
        }

        for (const uuid of blockSet) {
            await parseBlockForLink(uuid);
        }
        blockSet.clear();
    });
};

logseq.ready(main).catch(console.error);
