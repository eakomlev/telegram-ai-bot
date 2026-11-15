import assert from 'node:assert/strict';
import test from 'node:test';
import { instagramShortcode, isLikelyInstagramPostImage } from '../src/instagram-browser.js';

test('extracts instagram shortcode from post urls', () => {
  assert.equal(instagramShortcode('https://www.instagram.com/p/AbC_123/'), 'AbC_123');
  assert.equal(instagramShortcode('https://instagram.com/reel/xyz/'), 'xyz');
  assert.equal(instagramShortcode('https://example.com/p/x'), undefined);
});

test('filters likely post images vs avatars and tiny thumbs', () => {
  assert.equal(
    isLikelyInstagramPostImage('https://scontent.cdninstagram.com/v/t51.2885-15/123_n.jpg?_nc_ht=scontent'),
    true,
  );
  assert.equal(
    isLikelyInstagramPostImage(
      'https://scontent-ams2-1.cdninstagram.com/v/t51.82787-15/904741104_n.heic?stp=dst-jpg_e35_tt6',
    ),
    true,
  );
  assert.equal(
    isLikelyInstagramPostImage(
      'https://scontent.cdninstagram.com/v/t51.2885-19/341844931_n.jpg?stp=dst-jpg_s150x150_tt6',
    ),
    false,
  );
  assert.equal(isLikelyInstagramPostImage('https://example.com/pic.jpg'), false);
});
