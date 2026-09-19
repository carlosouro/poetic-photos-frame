#!/usr/bin/env node

/**
 * Migration Script: Purge AI-Generated Poems from texts.json
 * 
 * Preserves only authentic quotes with verified authors (type: "quote").
 * Creates a timestamped backup before performing any destructive file writes.
 */

import fs from 'fs';
import path from 'path';

const targetPath = process.argv[2] || path.resolve('./cache/texts.json');

console.log(`\n======================================================`);
console.log(`🧹  POETIC MEMORIES: POEM PURGE MIGRATION UTILITY`);
console.log(`======================================================`);
console.log(`🎯 Target database: ${targetPath}`);

if (!fs.existsSync(targetPath)) {
    console.error(`❌ Target file does not exist: ${targetPath}`);
    process.exit(1);
}

try {
    const rawData = fs.readFileSync(targetPath, 'utf-8');
    const db = JSON.parse(rawData);

    const initialTotal = Object.keys(db).length;
    console.log(`📊 Found ${initialTotal} total entries in database.`);

    // 1. Create Timestamped Backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${targetPath}.bak.${timestamp}`;
    fs.copyFileSync(targetPath, backupPath);
    console.log(`💾 Backup created: ${backupPath}`);

    // 2. Filter database to quotes only
    const cleanedDb = {};
    let keptQuotes = 0;
    let purgedPoems = 0;
    let purgedOthers = 0;

    for (const [photoPath, entry] of Object.entries(db)) {
        if (!entry || typeof entry !== 'object') {
            purgedOthers++;
            continue;
        }

        const isQuote = entry.type === 'quote';
        const hasAuthor = typeof entry.author === 'string' && entry.author.trim().length > 0 && entry.author !== 'null';
        const hasContent = typeof entry.content === 'string' && entry.content.trim().length > 0;

        if (isQuote && hasAuthor && hasContent) {
            cleanedDb[photoPath] = {
                content: entry.content.trim(),
                type: 'quote',
                author: entry.author.trim()
            };
            keptQuotes++;
        } else if (entry.type === 'poem') {
            purgedPoems++;
        } else {
            purgedOthers++;
        }
    }

    // 3. Write Cleaned Database Atomically
    const tempPath = `${targetPath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(cleanedDb, null, 2), 'utf-8');
    fs.renameSync(tempPath, targetPath);

    const finalSize = (fs.statSync(targetPath).size / 1024 / 1024).toFixed(2);

    console.log(`\n================= SUMMARY REPORT =================`);
    console.log(`✅ Kept Quotes (with authors):    ${keptQuotes}`);
    console.log(`🗑️  Purged Poems (rhymes):        ${purgedPoems}`);
    if (purgedOthers > 0) {
        console.log(`⚠️  Purged Invalid/Corrupt:       ${purgedOthers}`);
    }
    console.log(`📉 Database size:                 ${finalSize} MB`);
    console.log(`💾 Rollback file:                 ${backupPath}`);
    console.log(`==================================================\n`);

} catch (err) {
    console.error(`❌ Migration failed:`, err);
    process.exit(1);
}
