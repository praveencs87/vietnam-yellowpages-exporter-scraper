import { armKillSwitch, disarmKillSwitch } from './utils/timeoutManager.js';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        startUrls = [],
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'VN'
    });

    log.info(`Searching Vietnam directories...`);
    
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 2,
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            await page.waitForSelector('.listing-card, .company-box, .result-item, .business-card, .list-item, .search-result, .listing_box', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM.'));

            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Access Denied') || title.includes('Attention Required')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }

            // Scroll down a bit to trigger lazy loading
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            const items = await page.$$('.listing-card, .company-box, .result-item, .business-card, .list-item, .search-result, .listing_box');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('h2, h3, .company-name, .title, .biz-name, .company_name');
                if (!nameElement) continue;
                const companyName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.address, .location, .comp-loc, .biz-address, .address-text, .diachi');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Category
                const catElement = await item.$('.category, .industry, .cat-link, .nganhnghe');
                const industry = catElement ? (await catElement.innerText()).trim() : '';

                // Phones
                const phoneElement = await item.$('a[href^="tel:"], .phone, .contact-number, .call-btn, .mobile, .dienthoai');
                let phone = '';
                if (phoneElement) {
                    const href = await phoneElement.getAttribute('href');
                    if (href && href.startsWith('tel:')) {
                        phone = href.replace('tel:', '').trim();
                    } else {
                        phone = (await phoneElement.innerText()).trim();
                    }
                }
                
                // Website
                const websiteElement = await item.$('.website a, a[title*="Website"], a.co-web, .weblink a');
                const website = websiteElement ? await websiteElement.getAttribute('href') : '';
                
                // URL
                const urlElement = await item.$('h2 a, h3 a, .company-name a, .biz-name a, .title a, .company_name a');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://yellowpages.vnn.vn').toString() : listingUrl;

                if (companyName && companyName.length > 1) {
                    const record = {
                        companyName,
                        industry,
                        address,
                        phone,
                        website,
                        listingUrl: fullListingUrl,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${companyName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('.pagination a.next, a.next-page, a:has-text("Next"), a[rel="next"], li.next a, a:has-text("Trang sau")');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://yellowpages.vnn.vn').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                } else {
                    const currentUrl = new URL(request.url);
                    let pageNum = 1;
                    if (currentUrl.searchParams.has('page')) {
                        pageNum = parseInt(currentUrl.searchParams.get('page'));
                        currentUrl.searchParams.set('page', (pageNum + 1).toString());
                    } else if (currentUrl.searchParams.has('p')) {
                        pageNum = parseInt(currentUrl.searchParams.get('p'));
                        currentUrl.searchParams.set('p', (pageNum + 1).toString());
                    } else if (currentUrl.searchParams.has('pg')) {
                        pageNum = parseInt(currentUrl.searchParams.get('pg'));
                        currentUrl.searchParams.set('pg', (pageNum + 1).toString());
                    } else {
                        currentUrl.searchParams.set('page', '2');
                    }
                    
                    if(pageNum < 10) { 
                        log.info(`Attempting synthetic pagination to: ${currentUrl.toString()}`);
                        await enqueueLinks({
                            urls: [currentUrl.toString()],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    if (startUrls && startUrls.length > 0) {
        for (const req of startUrls) {
            await crawler.addRequests([{ url: typeof req === 'string' ? req : req.url }]);
        }
    } else {
        log.warning('No startUrls provided. Using default.');
        await crawler.addRequests([{ url: 'https://yellowpages.vn/cate/118497/garment-exporter.html' }]);
    }

    armKillSwitch(crawler);
    await crawler.run();
    disarmKillSwitch();

    log.info(`🎉 Done! Extracted ${extractedCount} Vietnam Exporter leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
