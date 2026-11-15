import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanProductTitle,
  isMarketplaceCdnImage,
  parseMarketplaceLink,
  pickWildberriesBasketHost,
  wildberriesArticleId,
  wildberriesVolPart,
} from '../src/marketplace.js';
import { parseGalleryLink } from '../src/gallery-utils.js';

test('parses wildberries product urls', () => {
  assert.equal(
    parseMarketplaceLink('https://www.wildberries.ru/catalog/95979396/detail.aspx')?.platform,
    'Wildberries',
  );
  assert.equal(
    parseMarketplaceLink('https://www.wildberries.ru/catalog/736674436/detail.aspx?size=1047015626')?.url,
    'https://www.wildberries.ru/catalog/736674436/detail.aspx',
  );
});

test('rejects ozon, yandex market and non-product wildberries urls', () => {
  assert.equal(parseMarketplaceLink('https://www.ozon.ru/product/nozhnitsy-kantselyarskie-21-sm-173091046/'), undefined);
  assert.equal(
    parseMarketplaceLink('https://market.yandex.ru/product--sony-playstation-5/925519649?sku=103706885579'),
    undefined,
  );
  assert.equal(parseMarketplaceLink('https://www.wildberries.ru/catalog/0/search.aspx?search=phone'), undefined);
});

test('parseGalleryLink accepts wildberries urls only among marketplaces', () => {
  assert.equal(parseGalleryLink('https://www.wildberries.ru/catalog/95979396/detail.aspx')?.platform, 'Wildberries');
  assert.equal(parseGalleryLink('https://www.ozon.ru/product/test-123/'), undefined);
});

test('finds wildberries urls inside titled messages and text_link entities', () => {
  const titled = parseMarketplaceLink(
    'Кроссовки Nike\nhttps://www.wildberries.ru/catalog/95979396/detail.aspx',
  );
  assert.equal(titled?.platform, 'Wildberries');

  const linkedTitle = 'Сенсорное мусорное ведро 10Л';
  const linked = parseMarketplaceLink(linkedTitle, [{
    type: 'text_link',
    offset: 0,
    length: linkedTitle.length,
    url: 'https://www.wildberries.ru/catalog/736674436/detail.aspx?size=1047015626',
  }]);
  assert.equal(linked?.platform, 'Wildberries');
  assert.equal(linked?.url, 'https://www.wildberries.ru/catalog/736674436/detail.aspx');
});

test('cleanProductTitle strips shop suffixes', () => {
  assert.equal(cleanProductTitle('Кроссовки купить на Wildberries', 'Wildberries'), 'Кроссовки');
});

test('filters marketplace CDN hosts', () => {
  assert.equal(isMarketplaceCdnImage('https://basket-01.wbbasket.ru/vol1/part1/1.webp', 'Wildberries'), true);
  assert.equal(isMarketplaceCdnImage('https://mow-basket-cdn-34.geobasket.ru/vol1/part1/1.webp', 'Wildberries'), true);
  assert.equal(isMarketplaceCdnImage('https://ir.ozone.ru/s3/multimedia-1/wc1000/123.jpg', 'Wildberries'), false);
  assert.equal(isMarketplaceCdnImage('https://basket-01.wbbasket.ru/vol1/part1/1.webp', 'Ozon'), false);
});

test('resolves wildberries article and basket host from vol ranges', () => {
  assert.equal(
    wildberriesArticleId('https://www.wildberries.ru/catalog/736674436/detail.aspx?size=1047015626'),
    736674436,
  );
  assert.deepEqual(wildberriesVolPart(736674436), { vol: 7366, part: 736674 });
  assert.equal(
    pickWildberriesBasketHost(7366, [
      { vol_range_from: 0, vol_range_to: 100, host: 'basket-01.wbbasket.ru' },
      { vol_range_from: 7062, vol_range_to: 7373, host: 'basket-34.wbbasket.ru' },
    ]),
    'basket-34.wbbasket.ru',
  );
});
