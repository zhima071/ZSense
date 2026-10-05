import { createUniver } from '@univerjs/presets'
import { UniverSheetsCoreWorkerPreset } from '@univerjs/preset-sheets-core/worker'
import { UniverSheetsFilterWorkerPreset } from '@univerjs/preset-sheets-filter/worker'

createUniver({ presets: [UniverSheetsCoreWorkerPreset(), UniverSheetsFilterWorkerPreset()] })
