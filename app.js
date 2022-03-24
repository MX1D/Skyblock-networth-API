const express = require("express");
const request = require("request");
const path = require("path");

const { parse, parseUncompressed } = require("prismarine-nbt");
let zlib = require("zlib");

const app = express();
const port = 3000;

var AvgLowestBin = { timestamp: 0, data: {} };
var bazaarData = { timestamp: 0, data: {} };

const fs = require("fs");
const reforgeStonesJSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "/resources/reforgestones.json"))
);
const petsJSON = JSON.parse(
  fs.readFileSync(path.join(__dirname, "/resources/pets.json"))
);

app.use(express.static(__dirname + '/source'));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "/source/index.html"));
});

app.get("/api/player/networth", async (req, res) => {
  var minecraftIGN = req.query.minecraft_ign;
  if (minecraftIGN == undefined) {
    res.json({
      success: false,
      cause: "Missing minecraft_ign field"
    });
    return;
  }

  var hypixelAPIKey = req.query.hypixel_api_key;
  if (hypixelAPIKey == undefined) {
    res.json({
      success: false,
      cause: "Mssing hypixel_api_key field"
    });
    return;
  }

  var [response, minecraftUUID] = await getMinecraftUUID(minecraftIGN);
  if (minecraftUUID.success == false) {
    res.json({
      success: false,
      cause: minecraftUUID.cause
    });
    return;
  }

  var [response, skyblockProfiles] = await getSkyblockProfiles(
    hypixelAPIKey,
    minecraftUUID.data.id
  );
  if (response.statusCode != 200) {
    let possibleCause = {
      403: 'Access is forbidden, usually due to an invalid API key being used.',
      429: 'A request limit has been reached, usually this is due to the limit on the key being reached but can also be triggered by a global throttle.'
    };
    let extraCause = possibleCause[response.statusCode];
    extraCause = extraCause == undefined ? '' : ` ( ${extraCause} )`;
    
    let errorCause = `There is problem talking with Hypixel API, ${response.statusCode}${extraCause}`;
    res.json({
      success: false,
      cause: errorCause
    });
    return;
  }

  if (skyblockProfiles.success == false) {
    res.json(skyblockProfiles);
    return;
  }

  var [response, bazaarProducts] = await getBazaarAPI(hypixelAPIKey);
  if (response.statusCode != 200) {
    let possibleCause = {
      403: 'Access is forbidden, usually due to an invalid API key being used.',
      429: 'A request limit has been reached, usually this is due to the limit on the key being reached but can also be triggered by a global throttle.'
    };
    let extraCause = possibleCause[response.statusCode];
    extraCause = extraCause == undefined ? '' : ` ( ${extraCause} )`;
    
    let errorCause = `There is problem talking with Hypixel API, ${response.statusCode}${extraCause}`;
    res.json({
      success: false,
      cause: errorCause
    });
    return;
  }

// if(minecraftUUID.data.id !== "738fe1f3097b4c5e864b87afb41291a2") return;

  if (bazaarProducts.success == false) {
    res.json({
      success: false,
      cause: bazaarProducts.cause
    });
    return;
  }

  var skyblockProfile = getLastProfile(
    skyblockProfiles.profiles,
    minecraftUUID.data.id
  );
  var networths = await calculateNetworth(
    skyblockProfile,
    minecraftUUID.data.id,
    bazaarProducts
  );

  res.json({
    success: true,
    data: {
      networth: networths,
      name: minecraftUUID.data.name,
      profile_name: skyblockProfile.cute_name
    }
  });
  return;
});

app.listen(port, () => {
  console.log(`MX1D's networth calculator is running on port ${port}!`);
});

function getMinecraftUUID(minecraftIGN) {
  var url = "https://api.mojang.com/users/profiles/minecraft/" + minecraftIGN;
  return new Promise(function(resolve, reject) {
    request(url, function(error, res, body) {
      if (error) reject(error);

      if (res.statusCode == 200)
        resolve([res, { success: true, data: JSON.parse(body) }]);

      let possibleCause = {
        204: 'No Content'
      };
      let extraCause = possibleCause[res.statusCode];
      extraCause = extraCause == undefined ? '' : ` ( ${extraCause} )`;
      
      let errorCause = `There is problem talking with Mojang API, ${res.statusCode}${extraCause}`;
      resolve([
        undefined,
        {
          success: false,
          cause: errorCause
        }
      ]);
    });
  });
}

function getSkyblockProfiles(hypixelAPIKey, minecraftUUID) {
  var options = {
    url: `https://api.hypixel.net/skyblock/profiles?uuid=${minecraftUUID}`,
    headers: { "API-Key": hypixelAPIKey }
  };
  return new Promise(function(resolve, reject) {
    request(options, function(error, res, body) {
      if (error) reject(error);

      resolve([res, JSON.parse(body)]);
    });
  });
}

function getLastProfile(profiles, minecraftUUID) {
  var latestTimestamp = 0;
  var latestSaveProfile = {};

  for (var key in profiles) {
    if (profiles[key].members[minecraftUUID].last_save > latestTimestamp) {
      latestSaveProfile = profiles[key];
      latestTimestamp = profiles[key].members[minecraftUUID].last_save;
    }
  }
  return latestSaveProfile;
}

async function calculateNetworth(profile, uuid, bazaarProducts) {
  // if(uuid !== "738fe1f3097b4c5e864b87afb41291a2") return;
  if(uuid !== "f03695547707486ab2308518f04102f7") {
  var coins = 0;
  if ("banking" in profile) coins += profile.banking.balance; // coop/- banking not including personal
  coins += profile.members[uuid].coin_purse; // purse

  // inv_armor
  var armoursValue = 0;
  var armoursList = [];
  var armourContent = await unpackedStorage(
    profile.members[uuid].inv_armor.data
  );

  for (var key in armourContent.value.i.value.value) {
    if (armourContent.value.i.value.value[key].tag == undefined) continue;
    var armourPrice = await calculateItemPrice(
      armourContent.value.i.value.value[key],
      bazaarProducts
    );

    armoursList.push(armourPrice);
    armoursValue += armourPrice.price;
  }
  armoursList.reverse(); // reverse to get helm->boots

  // pets
  var petsValue = 0;
  var petsList = profile.members[uuid].pets;
  var pets = [];
  for (var key in petsList) {
    var petPrice = await calculatePetPrice(petsList[key]);

    pets.push(petPrice);
    petsValue += petPrice.price;
  }

  // wardrobe_contents
  var wardrobeValue = 0;
  var wardrobeList = [];
  if (profile.members[uuid].wardrobe_contents != undefined) {
    var wardrobeContent = await unpackedStorage(
      profile.members[uuid].wardrobe_contents.data
    );
    for (var key in wardrobeContent.value.i.value.value) {
      var armourPrice = await calculateItemPrice(
        wardrobeContent.value.i.value.value[key],
        bazaarProducts
      );
      if (Object.keys(armourPrice).length === 0) continue;

      wardrobeList.push(armourPrice);
      wardrobeValue += armourPrice.price;
    }
  }

  // talisman_bag
  var accessoryValue = 0;
  var accessoryList = [];
  if (profile.members[uuid].talisman_bag != undefined) {
    var accessoryContent = await unpackedStorage(
      profile.members[uuid].talisman_bag.data
    );

    for (var key in accessoryContent.value.i.value.value) {
      var currentTalisman = accessoryContent.value.i.value.value[key];
      if (Object.keys(currentTalisman).length === 0) continue;

      var talismanPrice = await calculateItemPrice(
        currentTalisman,
        bazaarProducts
      );
      accessoryList.push(talismanPrice);
      accessoryValue += talismanPrice.price;
    }
  }

  // ender_chest_contents
  var enderchestValue = 0;
  var enderchestList = [];
  if(!profile.members[uuid].ender_chest_contents) return;
  if (profile.members[uuid].ender_chest_contents != undefined) {
    var enderchestContent = await unpackedStorage(
      profile.members[uuid].ender_chest_contents.data
    );

    for (var key in enderchestContent.value.i.value.value) {
      var currentItem = enderchestContent.value.i.value.value[key];
      
      var itemPrice = await calculateItemPrice(currentItem, bazaarProducts);
      if(!Object) return;
      if (!Object.keys) return;
      // if(!Object.keys(itemPrice)) return;
      
      if(itemPrice !== undefined){ 
      if (Object.keys(itemPrice).length === 0) continue;
      enderchestList.push(itemPrice);
      enderchestValue += itemPrice.price;
      }
    }
  }

  // backpack_contents
  var backpackValue = 0;
  var backpackList = [];
  if (profile.members[uuid].backpack_contents != undefined) {
    for (var backpack in profile.members[uuid].backpack_contents) {
      var backpackContent = await unpackedStorage(
        profile.members[uuid].backpack_contents[backpack].data
      );

      for (var key in backpackContent.value.i.value.value) {
        if(backpackContent.value.i.value.value[key].tag !== undefined) {
        var currentItem = backpackContent.value.i.value.value[key];
        
        var itemPrice = await calculateItemPrice(currentItem, bazaarProducts);
        
        if(itemPrice !== undefined){
        if (Object.keys(itemPrice).length === 0) continue;
        backpackList.push(itemPrice);
        backpackValue += itemPrice.price;
        }
        }
      }
    }
  }

  // inv_contents
  var inventoryValue = 0;
  var inventoryList = [];
  if (profile.members[uuid].inv_contents != undefined) {
    var inventoryContent = await unpackedStorage(
      profile.members[uuid].inv_contents.data
    );

    for (var key in inventoryContent.value.i.value.value) {
      var currentItem = inventoryContent.value.i.value.value[key];
      
      var itemPrice = await calculateItemPrice(currentItem, bazaarProducts);
      
      if(itemPrice !== undefined){
      if (Object.keys(itemPrice).length === 0) continue;
      inventoryList.push(itemPrice);
      inventoryValue += itemPrice.price;
      }
    }
  }

  // personal_vault_contents
  var vaultValue = 0;
  var vaultList = [];
  if (profile.members[uuid].personal_vault_contents != undefined) {
    var vaultContent = await unpackedStorage(
      profile.members[uuid].personal_vault_contents.data
    );

    for (var key in vaultContent.value.i.value.value) {
      var currentItem = vaultContent.value.i.value.value[key];
      
      var itemPrice = await calculateItemPrice(currentItem, bazaarProducts);
      if(Object === undefined || Object === null) return;

      if(itemPrice !== undefined){
      if (Object.keys(itemPrice).length === 0) continue;
      vaultList.push(itemPrice);
      vaultValue += itemPrice.price;
      }
    }
  }

  var total = coins;
  total += armoursValue;
  total += petsValue;
  total += wardrobeValue;
  total += accessoryValue;
  total += enderchestValue;
  total += backpackValue;
  total += inventoryValue;
  total += vaultValue;

  return {
    total: total,
    coins: coins,
    pets: {
      total: petsValue,
      pets: pets
    },
    armours: {
      total: armoursValue,
      armours: armoursList
    },
    wardrobe: {
      total: wardrobeValue,
      armours: wardrobeList
    },
    accessory: {
      total: accessoryValue,
      talismans: accessoryList
    },
    enderchest: {
      total: enderchestValue,
      items: enderchestList
    },
    backpack: {
      total: backpackValue,
      items: backpackList
    },
    inventory: {
      total: inventoryValue,
      items: inventoryList
    },
    vault: {
      total: vaultValue,
      items: vaultList
    }
    }
  };
}

async function calculateItemPrice(itemData, bazaarProducts) {
  // remove invalid items
  if (itemData == undefined) return {};
  if (itemData.tag == undefined) return {};
  if(itemData.tag.value === undefined) return;
  if(itemData.tag.value.ExtraAttributes === undefined) return;
  if(itemData.tag.value.ExtraAttributes.value === undefined) return;
  if(itemData.tag.value.ExtraAttributes.value.id === undefined) return;
  if(itemData.tag.value.ExtraAttributes.value.id.value === undefined) return;
  if(itemData.tag.value.ExtraAttributes.value.id.value === "CHEESE_FUEL") return;
  if(itemData.tag.value.ExtraAttributes.value.id.value === "ARROW") return;

  // remove glitch items
  if (itemData.tag.value.ExtraAttributes == undefined) return;

  var id = itemData.tag.value.ExtraAttributes.value.id.value;
  var name = itemData.tag.value.display.value.Name.value;

  var count = itemData.Count.value;

  // pet
  if (id == "PET") {
    var petPrice = await calculatePetPrice(
      JSON.parse(itemData.tag.value.ExtraAttributes.value.petInfo.value)
    );
    return petPrice;
  }

  var total = await getAvgLowestBin(bazaarProducts, id);
  if (id == "MIDAS_STAFF" || id == "MIDAS_SWORD")
    total = itemData.tag.value.ExtraAttributes.value.winning_bid.value;

  // remove dungeon savage items
  if (itemData.tag.value.ExtraAttributes.value.baseStatBoostPercentage != undefined) {
    if (itemData.tag.value.ExtraAttributes.value.dungeon_item_level == undefined) {
      return {
        name: name,
        id: id,
        skin: null,
        price: total,
        rarity: null
      };
    }
  }
  
  // recomb
  if (itemData.tag.value.ExtraAttributes.value.rarity_upgrades != undefined)
    total += await getBazaarPrice(bazaarProducts, "RECOMBOBULATOR_3000");

  // skin
  var skin = null;
  if (itemData.tag.value.ExtraAttributes.value.skin != undefined) {
    skin = itemData.tag.value.ExtraAttributes.value.skin.value;
    total += await getAvgLowestBin(bazaarProducts, skin);
  }

  // reforge
  if (itemData.tag.value.ExtraAttributes.value.modifier != undefined)
    total += await getReforgePrice(
      itemData.tag.value.ExtraAttributes.value.modifier.value
    );

  // enchants
  if (itemData.tag.value.ExtraAttributes.value.enchantments != undefined)
    total += await getEnchantsPrice(
      itemData.tag.value.ExtraAttributes.value.enchantments.value
    );

  // hot potato books
  if (itemData.tag.value.ExtraAttributes.value.hot_potato_count)
    total += await getHotPotatoBooksPrice(
      bazaarProducts,
      itemData.tag.value.ExtraAttributes.value.hot_potato_count.value
    );

  total *= count;
  
  return {
    name: name,
    id: id,
    skin: skin,
    price: total,
    rarity: null
  };
}

async function calculatePetPrice(petData) {
  if (petData == undefined) return {};
  if (petData == null) return {};

  if (petData.type == undefined) return {};

  var id = `${petData.type};${[
    "COMMON",
    "UNCOMMON",
    "RARE",
    "EPIC",
    "LEGENDARY"
  ].indexOf(petData.tier)}`;
  var total = await getAvgLowestBin({}, id);

  // pet skin
  if (petData.skin != null)
    total += await getAvgLowestBin({}, `PET_SKIN_${petData.skin}`);

  // pet item
  total += await getAvgLowestBin({}, petData.heldItem);

  return {
    name: petData.type,
    id: id,
    skin: petData.skin,
    rarity: petData.tier,
    price: total
  };
}

async function getEnchantsPrice(enchants) {
  if (enchants == undefined) return 0;
  if (enchants.length == 0) return 0;

  var total = 0;
  for (var key in enchants) {
    var id = `${key.toUpperCase()};${enchants[key].value}`;
    total += await getAvgLowestBin({}, id);
  }

  return total;
}

async function getReforgePrice(reforgeName) {
  if (reforgeName == undefined) return 0;
  if (reforgeName == "") return 0;

  for (var key in reforgeStonesJSON) {
    if (
      reforgeName.toLowerCase() ==
      reforgeStonesJSON[key].reforgeName.toLowerCase()
    ) {
      var id = reforgeStonesJSON[key].internalName;

      return await getAvgLowestBin({}, id);
    }
  }
  return 0;
}

async function getHotPotatoBooksPrice(products, hpbCount) {
  if (hpbCount == undefined) return 0;
  if (hpbCount == null) return 0;

  var fumingCount = hpbCount > 10 ? hpbCount - 10 : 0;
  var normalCount = hpbCount > 10 ? 10 : hpbCount;
  var total = normalCount * (await getBazaarPrice(products, "HOT_POTATO_BOOK"));
  total += fumingCount * (await getBazaarPrice(products, "FUMING_POTATO_BOOK"));
  return total;
}

async function unpackedStorage(encodedData) {
  var buffer = Buffer.from(encodedData, "base64");
  let unzipped = zlib.gunzipSync(buffer);

  var storageNBT = await parseUncompressed(unzipped);
  return storageNBT;
}

async function getBazaarPrice(products, itemID) {
  if (itemID === "ENDER_PEARL") return 7;
  if (itemID == undefined) return 0;
  if (itemID == null) return 0;

  if (itemID in products.products)
    return products.products[itemID].quick_status.buyPrice;
  return 0;
}

function getBazaarAPI(hypixelAPIKey) {
  var options = {
    url: `https://api.hypixel.net/skyblock/bazaar`,
    headers: { "API-Key": hypixelAPIKey }
  };
  return new Promise(function(resolve, reject) {
    request(options, function(error, res, body) {
      if (error) reject(error);

      resolve([res, JSON.parse(body)]);
    });
  });
}

async function getAvgLowestBin(products, itemID) {
  if (itemID === "ENDER_PEARL") return 7;
  if (itemID == undefined) return 0;
  if (itemID == null) return 0;

  let currentTime = Date.now();
  if (currentTime - AvgLowestBin.timestamp >= 5 * 60 * 1000) {
    AvgLowestBin.timestamp = currentTime;
    AvgLowestBin.data = await getMoulberryAPI();
  }

  if (itemID in AvgLowestBin.data) return AvgLowestBin.data[itemID];
  if (products == undefined) return 0;
  if (products == null) return 0;
  if (Object.keys(products).length === 0) return 0;

  if (itemID in products.products)
    return products.products[itemID].quick_status.buyPrice;

  var itemData = await getMoulberryGithub(itemID);
  if (itemData.recipe == undefined) return 0;

  var craftPrice = 0;
  for (var key in itemData.recipe) {
    if (itemData.recipe[key].length == 0) continue;
    var recipeID = itemData.recipe[key].split(":")[0];
    var recipeCount = itemData.recipe[key].split(":")[1];

    craftPrice += recipeCount * (await getAvgLowestBin(products, recipeID));
  }
  if (craftPrice != 0) return craftPrice;

  console.log(`Missing ${itemID} bin data`);
  return 0;
}

function getMoulberryAPI() {
  var options = {
    url: "https://moulberry.codes/auction_averages_lbin/1day.json.gz",
    headers: {
      "Accept-Encoding": "gzip, deflate"
    },
    encoding: null
  };
  return new Promise(function(resolve, reject) {
    request(options, function(error, res, body) {
      if (error) reject(error);

      if (res.statusCode != 200) reject(error);
      let unzipped = zlib.gunzipSync(body);
      resolve(JSON.parse(unzipped));
    });
  });
}

function getMoulberryGithub(itemID) {
  var options = {
    url: `https://raw.githubusercontent.com/Moulberry/NotEnoughUpdates-REPO/master/items/${itemID}.json`
  };
  return new Promise(function(resolve, reject) {
    request(options, function(error, res, body) {
      if (error) reject(error);

      if (res.statusCode == 200) resolve([res, JSON.parse(body)]);
      resolve([res, {}]);
    });
  });
}
