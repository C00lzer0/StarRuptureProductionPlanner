INSERT INTO items (name, icon) values 
("Titanium Ore",""),("Titanium Bar",""),("Titanium Rod",""),("Titanium Sheet",""),("Titanium Beam",""),("Wolfram Ore",""),("Wolfram Bar",""),("Wolfram Sheet",""),("Wolfram Wire",""),("Wolfram Powder",""),
("Calcium Ore",""),("Calcium Block",""),("Calcite Sheets",""),("Calcium Powder",""),("Helium-3",""),("Glass",""),("Ceramics",""),("Rotor",""),("Titanium Housing",""),("Tube",""),
("Chemicals",""),("Heat Resistant Sheet",""),("Stabilizer",""),("Stator",""),("Synthetic Silicon",""),("Applicator",""),("Electronics",""),("Inductor",""),("Turbine",""),("Valve",""),
("Battery",""),("Hardening Agent",""),("Impeller",""),("Nozzle",""),("Pressurized Helium",""),("Sulphur Ore",""),("Sulphuric Acid",""),("Supermagnet",""),("Accumulator",""),("Electromagnetic Coil",""),
("Generator",""),("Liquid Helium",""),("Pressure Tank",""),("Synthetic Resin",""),("Synthetic Fertilizer",""),("Goethite Ore",""),("Goethite Ingot",""),("Goethite Lattice",""),("Goethite Powder",""),
("Lens",""),("Pump",""),("Resonator",""),("Superconductor",""),("Titanoferrite Ingot",""),("Universal Space Soil",""),("Wolfram Steel Ingot",""),("Aerogel",""),("Basic Fuel",""),("Crude Oil",""),
("Refined Oil",""),("Electromagnet",""),("Epoxy",""),("Ion Injector",""),("Laser Emitter",""),("Nanofibre",""),("Organic Compound",""),("Plastic",""),("Reinforced Frame",""),("Reinforced Housing",""),
("Scanner",""),("Arc Reactor",""),("Condenser",""),("Dome",""),("Explosive Charge",""),("Ion Stabilizer",""),("Ion Thrusters",""),("Micro Satellite",""),("Neutrino Missile",""),("Organ Producer",""),
("Plastic Dust",""),("Pseudorubber Insulator",""),("Rocket Engine",""),("Self-sustained Habitat",""),("Substance FHS-135-493",""),("Synthetic Protein",""),("Anti-Radiation Covers",""),("Control Systems",""),("Missile Housing",""),("Nanosyringe",""),
("Onboard Instruments",""),("RNA Stabilizer",""),("RTSC",""),("Satellite Body",""),("Scafolding",""),("Uberfilament",""),("Airlock",""),("Biofilament",""),("Carbon Sonar",""),("Containment Vessel",""),
("Cyclotrone",""),("Heat Shield",""),("Plasma Generator",""),("Quantum Tranqualizer",""),("Rocket Fuel",""),("Synthetic DNA",""),("Bioprinter",""),("Converter",""),("Ion Bomb",""),("Mars Habitat Base",""),
("Molecular Scalpel",""),("Payload Stage",""),("Propulsion Stage",""),("RTSC Generator",""),("Tracking Device",""),("Antimatter Generator",""),("Genome Alternator",""),("Neutrino Bomb",""),("Plasma Oxygen Converter",""),("Satellite Assembly","")

INSERT INTO buildings (name, icon, [power], temperature) values 
("Ore Excavator","",5,3),("Helium-3 Extractor","",15,60),("Sulfur Extractor","",40,60),("Laser Drill","",250,200),("Oil Extractor","",400,300),("Ore Excavator v2","",30,18),
("Smelter","",5,3),("Furnance","",20,8),("Megapress","",30,15),("Compounder","",60,150),("Pyro Forge","",200,180),("Furnance v2","",50,14),("Compounder v2","",180,250),("Fabricator","",10,5),
("Assembler","",60,150),("Constructorizer","",700,500),("Fabricator v2","",25,8),("Constructorizer v2","",700,500),("Facturer","",850,650),("Pressurizer","",40,60),("Refinery","",150,100)

INSERT INTO blueprints (name, icon, building_id, output_item_id, output_amount) values 