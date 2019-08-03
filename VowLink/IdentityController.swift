//
//  IdentityController.swift
//  VowLink
//
//  Created by Indutnyy, Fedor on 7/30/19.
//  Copyright © 2019 Indutnyy, Fedor. All rights reserved.
//

import UIKit

class IdentityController : UIViewController, UIPickerViewDelegate, UIPickerViewDataSource {
    @IBOutlet weak var identityPicker: UIPickerView!
    @IBOutlet weak var selectButton: UIButton!
    var app: AppDelegate!
    var context: Context!
    var identities = [Identity]()
    
    override func viewDidLoad() {
        super.viewDidLoad()
        
        app = (UIApplication.shared.delegate as! AppDelegate)
        context = app.context
        
        let keys = context.keychain.allKeys().filter { (key) -> Bool in
            return key.starts(with: "identity/")
        }
        
        for key in keys {
            let index = key.index(key.startIndex, offsetBy: 9)
            do {
                identities.append(try Identity(context: context, name: String(key[index...])))
            } catch {
                debugPrint("failed to fetch identity due to error \(error)")
            }
        }
        
        selectButton.isEnabled = identities.count != 0
        if identities.count > 0 {
            app.identity = identities[0]
        }
        
        identityPicker.delegate = self
        identityPicker.dataSource = self
    }
    
    func numberOfComponents(in pickerView: UIPickerView) -> Int {
        return 1
    }
    
    func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int {
        return identities.count
    }
    
    func pickerView(_ pickerView: UIPickerView, titleForRow row: Int, forComponent component: Int) -> String? {
        return identities[row].name
    }
    
    func pickerView(_ pickerView: UIPickerView, didSelectRow row: Int, inComponent component: Int) {
        app.identity = identities[row]
    }

    // MARK: - Miscellaneous
    
    @IBAction func eraseClicked(_ sender: Any) {
        try! context.keychain.removeAll()
        fatalError("Intentially crashing the app")
    }
    
    // MARK: - Identity Manager
    
    func createIdentity(name: String) throws {
        // TODO(indutny): avoid duplicates by throwing
        let id = try Identity(context: context, name: name)
        identities.append(id)
        selectButton.isEnabled = true
        identityPicker.reloadAllComponents()
        
        // Picker has been reloaded, so load the selected
        app.identity = identities[identityPicker.selectedRow(inComponent: 0)]

        // Subscribe to our own channel
        try app.channels.add(publicKey: id.publicKey, label: name)
    }
}
