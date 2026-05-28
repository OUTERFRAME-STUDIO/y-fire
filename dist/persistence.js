var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { get, set, del } from "idb-keyval";
export const idbKeyvalAdapter = {
    getLocal: (key) => get(key),
    setLocal: (key, value) => set(key, value),
    deleteLocal: (key) => del(key),
};
export const noopAdapter = {
    getLocal: () => __awaiter(void 0, void 0, void 0, function* () { return undefined; }),
    setLocal: () => __awaiter(void 0, void 0, void 0, function* () { }),
    deleteLocal: () => __awaiter(void 0, void 0, void 0, function* () { }),
};
export function createPersistenceAdapter(mode = "indexeddb") {
    return mode === "none" ? noopAdapter : idbKeyvalAdapter;
}
