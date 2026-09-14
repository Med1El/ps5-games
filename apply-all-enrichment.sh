#!/bin/bash
# Apply all enrichment batches

for i in $(seq 1 43); do
  echo "Applying enrichment batch $i..."
  node scripts/merge-enrichment.js data/enrichments/enrichment-data-batch$i.json
done

echo "All enrichment batches applied!"
